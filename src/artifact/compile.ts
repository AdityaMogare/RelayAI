import type { Action, ArtifactStep, Capability, Observation } from "../core/types.ts";
import { looksSensitive } from "../policy/redact.ts";
import { DISPUTE_EXCEPTIONS, VENDOR_EXCEPTIONS } from "./schema.ts";

export type RecordedStep = {
  action: Action;
  observationBefore: Observation;
  usedLocatorName?: string;
  risk: "safe" | "risky";
};

function toCamel(label: string): string {
  const cleaned = label.replace(/[^a-zA-Z0-9]+/g, " ").trim();
  const parts = cleaned.split(/\s+/);
  return parts
    .map((p, i) => (i === 0 ? p.toLowerCase() : p[0]!.toUpperCase() + p.slice(1).toLowerCase()))
    .join("");
}

function valuesFromGoal(goal: string): string[] {
  const quoted = [...goal.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  const matches = goal.match(/[A-Za-z0-9._-]{3,}/g) ?? [];
  const tokens = matches.filter((m) => /\d/.test(m) || m.includes("-"));
  return [...new Set([...quoted, ...tokens])];
}

function paramType(name: string, matched: string): "string" | "number" {
  if (/id$/i.test(name)) return "string";
  return /^\d+$/.test(matched) ? "number" : "string";
}

function exceptionsFor(id: string, goal: string) {
  const dispute = /dispute/i.test(id) || /dispute/i.test(goal);
  return dispute ? [...VENDOR_EXCEPTIONS, ...DISPUTE_EXCEPTIONS] : VENDOR_EXCEPTIONS;
}

function successExpect(id: string, outputs: Record<string, string>): string {
  const confirmation = outputs.confirmation?.toLowerCase() ?? "";
  if (/dispute/i.test(id) || confirmation.includes("dispute")) return "Dispute filed";
  if (confirmation.includes("sub-account") || /sub-account/i.test(id)) return "Sub-account opened";
  if (outputs.savingsBalance || /lookup|savings/i.test(id)) return "Savings Balance";
  return "Member";
}

export function compileArtifact(input: {
  goal: string;
  targetUrl: string;
  recorded: RecordedStep[];
  outputs: Record<string, string>;
  id?: string;
}): Capability {
  const candidates = valuesFromGoal(input.goal);
  const parameters: Capability["parameters"] = [];
  const steps: ArtifactStep[] = [];
  const seenParams = new Set<string>();

  const navigate: ArtifactStep = {
    id: "s00-navigate",
    action: "navigate",
    url: stripQuery(input.targetUrl),
    risk: "safe",
    note: "Entry point for this vendor console.",
  };
  steps.push(navigate);

  input.recorded.forEach((rec, index) => {
    const id = `s${String(index + 1).padStart(2, "0")}-${rec.action.name}`;
    let inputFrom: string | undefined;
    let value = rec.action.value;

    if ((rec.action.name === "type" || rec.action.name === "select") && value) {
      const matched = candidates.find((c) => c === value);
      if (matched) {
        const field = rec.action.target?.primary.name ?? rec.usedLocatorName ?? "value";
        const name = toCamel(field);
        if (!seenParams.has(name)) {
          seenParams.add(name);
          parameters.push({
            name,
            type: paramType(name, matched),
            description: `Value typed into ${field} during discovery.`,
            sensitive: looksSensitive(name),
          });
        }
        inputFrom = `parameters.${name}`;
        value = undefined;
      }
    }

    if (rec.action.name === "extract" && rec.action.target?.primary.role === "button") {
      return;
    }

    if (
      rec.action.name === "extract" &&
      steps.at(-1)?.action === "extract" &&
      steps.at(-1)?.outputName === rec.action.outputName &&
      JSON.stringify(steps.at(-1)?.target) === JSON.stringify(rec.action.target)
    ) {
      return;
    }

    steps.push({
      id,
      action: rec.action.name,
      target: rec.action.target,
      value,
      inputFrom,
      url: rec.action.url,
      outputName: rec.action.outputName,
      risk: rec.risk,
    });
  });

  const outputs: Capability["outputs"] = Object.keys(input.outputs).map((name) => {
    const extractStep = [...input.recorded].reverse().find((r) => r.action.outputName === name);
    return {
      name,
      type: /balance|amount|money/i.test(name) ? ("money" as const) : ("string" as const),
      locator:
        extractStep?.action.target ?? {
          primary: { by: "role" as const, role: "cell", name: name },
        },
    };
  });

  const id = input.id ?? inferId(input.goal);

  return {
    schemaVersion: "1.0",
    id,
    name: humanize(id),
    description: input.goal,
    version: 1,
    app: {
      vendorId: "relay-core",
      surfaceKind: "legacy-web",
    },
    parameters,
    outputs,
    steps,
    exceptionalStates: exceptionsFor(id, input.goal),
    success: {
      checkpoint: {
        kind: "textIncludes",
        expect: successExpect(id, input.outputs),
      },
    },
  };
}

function stripQuery(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

function inferId(goal: string): string {
  const slug = goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return slug || "capability";
}

function humanize(id: string): string {
  return id
    .split("-")
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

export const LOOKUP_MEMBER_SAVINGS: Capability = {
  schemaVersion: "1.0",
  id: "lookup-member-savings",
  name: "Lookup Member Savings Balance",
  description: "Look up a member by ID and read their current savings balance.",
  version: 1,
  app: { vendorId: "relay-core", surfaceKind: "legacy-web" },
  parameters: [
    {
      name: "memberId",
      type: "string",
      description: "Member number supplied per invocation.",
      sensitive: false,
    },
  ],
  outputs: [
    {
      name: "savingsBalance",
      type: "money",
      description: "Current savings balance displayed on the member record.",
      locator: { primary: { by: "role", role: "cell", name: "Savings Balance" } },
    },
  ],
  steps: [
    {
      id: "s00-navigate",
      action: "navigate",
      url: "http://127.0.0.1:3000/",
      risk: "safe",
    },
    {
      id: "s01-type",
      action: "type",
      target: {
        primary: { by: "role", role: "textbox", name: "Member ID" },
        fallbacks: [{ by: "label", name: "Member ID" }],
      },
      inputFrom: "parameters.memberId",
      risk: "safe",
      checkpoint: { kind: "textIncludes", expect: "Member Lookup" },
    },
    {
      id: "s02-click",
      action: "click",
      target: {
        primary: { by: "role", role: "button", name: "Search" },
        fallbacks: [{ by: "text", text: "Search" }],
      },
      risk: "safe",
    },
    {
      id: "s03-extract",
      action: "extract",
      target: {
        primary: { by: "role", role: "cell", name: "Savings Balance" },
        fallbacks: [{ by: "css", selector: '[aria-label="Savings Balance"]' }],
      },
      outputName: "savingsBalance",
      risk: "safe",
      checkpoint: { kind: "textIncludes", expect: "Savings Balance" },
    },
  ],
  exceptionalStates: VENDOR_EXCEPTIONS,
  success: { checkpoint: { kind: "textIncludes", expect: "Savings Balance" } },
};

export const OPEN_SUB_ACCOUNT: Capability = {
  schemaVersion: "1.0",
  id: "open-sub-account",
  name: "Open Sub-Account",
  description: "Open a new sub-account for a member and reach the confirmation screen.",
  version: 1,
  app: { vendorId: "relay-core", surfaceKind: "legacy-web" },
  parameters: [
    { name: "memberId", type: "string", description: "Member number." },
    { name: "product", type: "string", description: "Product to open." },
  ],
  outputs: [
    {
      name: "confirmation",
      type: "string",
      locator: { primary: { by: "role", role: "status", name: "Confirmation" } },
    },
  ],
  steps: [
    {
      id: "s00-navigate",
      action: "navigate",
      url: "http://127.0.0.1:3000/",
      risk: "safe",
    },
    {
      id: "s01-type",
      action: "type",
      target: { primary: { by: "role", role: "textbox", name: "Member ID" } },
      inputFrom: "parameters.memberId",
      risk: "safe",
    },
    {
      id: "s02-search",
      action: "click",
      target: { primary: { by: "role", role: "button", name: "Search" } },
      risk: "safe",
    },
    {
      id: "s03-open",
      action: "click",
      target: { primary: { by: "role", role: "link", name: "Open Sub-Account" } },
      risk: "safe",
      note: "Opening the form is reversible; confirmation later is not.",
    },
    {
      id: "s04-product",
      action: "select",
      target: { primary: { by: "role", role: "combobox", name: "Product" } },
      inputFrom: "parameters.product",
      risk: "safe",
    },
    {
      id: "s05-continue",
      action: "click",
      target: { primary: { by: "role", role: "button", name: "Continue" } },
      risk: "safe",
    },
    {
      id: "s06-confirm",
      action: "click",
      target: { primary: { by: "role", role: "button", name: "Confirm" } },
      risk: "risky",
      note: "Irreversible confirmation. Unattended replay requires --approve-risky.",
    },
    {
      id: "s07-extract",
      action: "extract",
      target: { primary: { by: "role", role: "status", name: "Confirmation" } },
      outputName: "confirmation",
      risk: "safe",
    },
  ],
  exceptionalStates: VENDOR_EXCEPTIONS,
  success: { checkpoint: { kind: "textIncludes", expect: "Sub-account opened" } },
};

export const VERIFY_AND_FILE_DISPUTE: Capability = {
  schemaVersion: "1.0",
  id: "verify-and-file-dispute",
  name: "Verify And File Dispute",
  description: "Look up a member dispute, verify the transaction amount, and file it.",
  version: 1,
  app: { vendorId: "relay-core", surfaceKind: "legacy-web" },
  parameters: [
    { name: "memberId", type: "string", description: "Member number." },
    { name: "disputeId", type: "string", description: "Dispute identifier on the member queue." },
    { name: "reason", type: "string", description: "Filing reason shown on the form." },
  ],
  outputs: [
    {
      name: "transactionAmount",
      type: "money",
      description: "Amount displayed on the dispute detail before filing.",
      locator: { primary: { by: "role", role: "cell", name: "Transaction Amount" } },
    },
    {
      name: "confirmation",
      type: "string",
      description: "Confirmation text after the dispute is filed.",
      locator: { primary: { by: "role", role: "status", name: "Confirmation" } },
    },
  ],
  steps: [
    {
      id: "s00-navigate",
      action: "navigate",
      url: "http://127.0.0.1:3000/",
      risk: "safe",
    },
    {
      id: "s01-type",
      action: "type",
      target: {
        primary: { by: "role", role: "textbox", name: "Member ID" },
        fallbacks: [{ by: "label", name: "Member ID" }],
      },
      inputFrom: "parameters.memberId",
      risk: "safe",
      checkpoint: { kind: "textIncludes", expect: "Member Lookup" },
    },
    {
      id: "s02-search",
      action: "click",
      target: {
        primary: { by: "role", role: "button", name: "Search" },
        fallbacks: [{ by: "text", text: "Search" }],
      },
      risk: "safe",
    },
    {
      id: "s03-disputes",
      action: "click",
      target: { primary: { by: "role", role: "link", name: "Disputes" } },
      risk: "safe",
      checkpoint: { kind: "textIncludes", expect: "Dispute Queue" },
    },
    {
      id: "s04-dispute-id",
      action: "type",
      target: {
        primary: { by: "role", role: "textbox", name: "Dispute ID" },
        fallbacks: [{ by: "label", name: "Dispute ID" }],
      },
      inputFrom: "parameters.disputeId",
      risk: "safe",
    },
    {
      id: "s05-open",
      action: "click",
      target: { primary: { by: "role", role: "button", name: "Open" } },
      risk: "safe",
    },
    {
      id: "s06-extract-amount",
      action: "extract",
      target: {
        primary: { by: "role", role: "cell", name: "Transaction Amount" },
        fallbacks: [{ by: "css", selector: '[aria-label="Transaction Amount"]' }],
      },
      outputName: "transactionAmount",
      risk: "safe",
      checkpoint: { kind: "textIncludes", expect: "Transaction Amount" },
    },
    {
      id: "s07-file",
      action: "click",
      target: { primary: { by: "role", role: "link", name: "File Dispute" } },
      risk: "safe",
      note: "Opening the file form is reversible; confirmation later is not.",
      checkpoint: { kind: "textIncludes", expect: "File Card Dispute" },
    },
    {
      id: "s08-reason",
      action: "select",
      target: { primary: { by: "role", role: "combobox", name: "Reason" } },
      inputFrom: "parameters.reason",
      risk: "safe",
    },
    {
      id: "s09-continue",
      action: "click",
      target: { primary: { by: "role", role: "button", name: "Continue" } },
      risk: "safe",
    },
    {
      id: "s10-confirm",
      action: "click",
      target: { primary: { by: "role", role: "button", name: "Confirm" } },
      risk: "risky",
      note: "Irreversible filing. Unattended replay requires --approve-risky.",
    },
    {
      id: "s11-extract",
      action: "extract",
      target: { primary: { by: "role", role: "status", name: "Confirmation" } },
      outputName: "confirmation",
      risk: "safe",
    },
  ],
  exceptionalStates: [...VENDOR_EXCEPTIONS, ...DISPUTE_EXCEPTIONS],
  success: { checkpoint: { kind: "textIncludes", expect: "Dispute filed" } },
};
