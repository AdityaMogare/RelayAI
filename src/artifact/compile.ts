import type { Action, ArtifactStep, Capability, LocatorScope, Observation, Provenance } from "../core/types.ts";
import { looksSensitive } from "../policy/redact.ts";
import { canonicalizeUrl } from "./canonical.ts";
import { checkpointFromDelta, EMPTY_OBSERVATION } from "./checkpoint.ts";
import {
  CURRENT_SCHEMA_VERSION,
  DEFAULT_RETRY_BUDGET,
  DEFAULT_STEP_TIMEOUT_MS,
  IRREVERSIBLE_COMPENSATION,
  READ_ONLY_COMPENSATION,
  VENDOR_ANTI_CHECKPOINTS,
} from "./defaults.ts";
import { rankedTarget, rankedTargetFrom } from "./ranked.ts";
import { DISPUTE_EXCEPTIONS, VENDOR_EXCEPTIONS } from "./schema.ts";

export type RecordedStep = {
  action: Action;
  observationBefore: Observation;
  observationAfter?: Observation;
  usedLocatorName?: string;
  risk: "safe" | "risky";
  row?: { headers: string[]; cells: string[] };
  assistedBy?: string;
};

export { rankedTarget, rankedTargetFrom, promoteHits } from "./ranked.ts";
export { checkpointFromDelta } from "./checkpoint.ts";

const GENERIC_CONTROL = /^(open|select|view|choose|details|open row)$/i;
const ROW_HEADER_PARAM: Record<string, string> = {
  merchant: "merchant",
  card: "last4",
  "last 4": "last4",
  "card last 4": "last4",
  last4: "last4",
  "member id": "memberId",
};

function toCamel(label: string): string {
  const cleaned = label.replace(/[^a-zA-Z0-9]+/g, " ").trim();
  const parts = cleaned.split(/\s+/);
  return parts
    .map((p, i) => (i === 0 ? p.toLowerCase() : p[0]!.toUpperCase() + p.slice(1).toLowerCase()))
    .join("");
}

function paramType(name: string, matched: string): "string" | "number" {
  if (/id$/i.test(name) || /name|merchant|reason|last4/i.test(name)) return "string";
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

function budget(step: Omit<ArtifactStep, "timeoutMs" | "retryBudget">): ArtifactStep {
  return { timeoutMs: DEFAULT_STEP_TIMEOUT_MS, retryBudget: DEFAULT_RETRY_BUDGET, ...step };
}

function ensureParam(
  parameters: Capability["parameters"],
  seen: Set<string>,
  name: string,
  value: string,
  description: string,
): void {
  if (seen.has(name)) return;
  seen.add(name);
  parameters.push({
    name,
    type: paramType(name, value),
    description,
    sensitive: looksSensitive(name),
  });
}

function rowScope(
  rec: RecordedStep,
  parameters: Capability["parameters"],
  seen: Set<string>,
  paramValues: Record<string, string>,
): LocatorScope | undefined {
  const row = rec.row;
  if (!row || row.cells.length === 0) return undefined;
  const name = rec.action.target?.primary.name ?? rec.usedLocatorName ?? "";
  if (name && !GENERIC_CONTROL.test(name) && rec.action.name !== "click") return undefined;
  const hasText: string[] = [];
  row.headers.forEach((header, i) => {
    const key = ROW_HEADER_PARAM[header.trim().toLowerCase()];
    const cell = row.cells[i]?.trim() ?? "";
    if (!key || !cell) return;
    ensureParam(parameters, seen, key, cell, `Identifying cell from the ${header} column.`);
    paramValues[key] = cell;
    hasText.push(`:${key}`);
  });
  if (hasText.length === 0 && GENERIC_CONTROL.test(name)) {
    const interesting = row.cells.filter((cell) => cell && !GENERIC_CONTROL.test(cell) && cell !== name);
    if (interesting[0]) hasText.push(interesting[0]);
    if (interesting[1]) hasText.push(interesting[1]);
  }
  return hasText.length > 0 ? { by: "row", hasText } : undefined;
}

function valuesFromGoal(goal: string): string[] {
  const quoted = [...goal.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  const matches = goal.match(/[A-Za-z0-9._-]{3,}/g) ?? [];
  const tokens = matches.filter((m) => /\d/.test(m) || m.includes("-"));
  return [...new Set([...quoted, ...tokens])];
}

export function compileArtifact(input: {
  goal: string;
  targetUrl: string;
  recorded: RecordedStep[];
  outputs: Record<string, string>;
  id?: string;
  provenance?: Partial<Provenance>;
}): Capability {
  const parameters: Capability["parameters"] = [];
  const paramValues: Record<string, string> = {};
  const steps: ArtifactStep[] = [];
  const seenParams = new Set<string>();

  const landing = input.recorded[0]?.observationBefore;
  const navigate = budget({
    id: "s00-navigate",
    action: "navigate",
    url: canonicalizeUrl(stripQuery(input.targetUrl), paramValues),
    risk: "safe",
    note: "Entry point for this vendor console.",
    checkpoint: landing ? checkpointFromDelta(EMPTY_OBSERVATION, landing, []) : undefined,
  });
  steps.push(navigate);

  input.recorded.forEach((rec, index) => {
    const id = `s${String(index + 1).padStart(2, "0")}-${rec.action.name}`;
    let inputFrom: string | undefined;
    let value = rec.action.value;

    if ((rec.action.name === "type" || rec.action.name === "select") && value) {
      const field = rec.action.target?.primary.name ?? rec.usedLocatorName ?? "value";
      const name = toCamel(field);
      ensureParam(
        parameters,
        seenParams,
        name,
        value,
        `Value ${rec.action.name === "select" ? "selected in" : "typed into"} ${field} during discovery.`,
      );
      paramValues[name] = value;
      inputFrom = `parameters.${name}`;
      value = undefined;
    }

    if (rec.action.name === "extract" && rec.action.target?.primary.role === "button") {
      return;
    }

    if (
      rec.action.name === "extract" &&
      steps.at(-1)?.action === "extract" &&
      steps.at(-1)?.outputName === rec.action.outputName &&
      JSON.stringify(rankedTargetFrom(steps.at(-1)?.target)) === JSON.stringify(rankedTargetFrom(rec.action.target))
    ) {
      return;
    }

    const scope = rowScope(rec, parameters, seenParams, paramValues);
    const target = rankedTargetFrom(
      rec.action.target
        ? {
            ...rec.action.target,
            primary: { ...rec.action.target.primary, scope: rec.action.target.primary.scope ?? scope },
          }
        : rec.action.target,
    );

    const avoid = [...new Set([...Object.values(paramValues), ...valuesFromGoal(input.goal)])];
    const checkpoint = rec.observationAfter
      ? checkpointFromDelta(rec.observationBefore, rec.observationAfter, avoid, paramValues)
      : undefined;

    steps.push(
      budget({
        id,
        action: rec.action.name,
        target,
        value,
        inputFrom,
        url: rec.action.url ? canonicalizeUrl(rec.action.url, paramValues) : undefined,
        outputName: rec.action.outputName,
        risk: rec.risk,
        checkpoint,
        assistedBy: rec.assistedBy,
      }),
    );
  });

  for (const step of steps) {
    if (step.url) step.url = canonicalizeUrl(step.url, paramValues);
  }

  const avoid = [...new Set([...Object.values(paramValues), ...valuesFromGoal(input.goal)])];
  if (navigate.checkpoint && landing) {
    navigate.checkpoint = checkpointFromDelta(EMPTY_OBSERVATION, landing, avoid, paramValues);
  }

  const outputs: Capability["outputs"] = Object.keys(input.outputs).map((name) => {
    const extractStep = [...input.recorded].reverse().find((r) => r.action.outputName === name);
    const type = /balance|amount|money/i.test(name) ? ("money" as const) : ("string" as const);
    return {
      name,
      type,
      locator: rankedTargetFrom(extractStep?.action.target) ?? rankedTarget("cell", name),
      pii: true,
    };
  });

  const id = input.id ?? inferId(input.goal);
  const risky = steps.some((s) => s.risk === "risky");
  const entryCheckpoint =
    navigate.checkpoint ??
    steps.find((s) => s.checkpoint)?.checkpoint ?? {
      kind: "textIncludes" as const,
      expect: "Member Lookup",
    };

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id,
    name: humanize(id),
    description: humanize(id),
    auth: { credentialRef: "vault://tenant-9/teller" },
    version: 1,
    app: {
      vendorId: "relay-core",
      surfaceKind: "legacy-web",
    },
    parameters,
    outputs,
    sideEffects: {
      kind: risky ? "irreversible" : "none",
      compensation: risky ? IRREVERSIBLE_COMPENSATION : READ_ONLY_COMPENSATION,
    },
    preconditions: {
      requiresSession: true,
      requiresRole: "teller",
      entryCheckpoint,
    },
    uses: [],
    provenance: {
      discoveredAt: input.provenance?.discoveredAt ?? new Date().toISOString(),
      discoveredBy: input.provenance?.discoveredBy ?? "model",
      model: input.provenance?.model,
      promptHash: input.provenance?.promptHash,
      evidenceRunId: input.provenance?.evidenceRunId,
      goal: input.provenance?.goal ?? input.goal,
      assistedBy:
        input.provenance?.assistedBy ?? input.recorded.find((rec) => rec.assistedBy)?.assistedBy,
    },
    idempotencyKeyFrom: risky ? parameters.map((p) => p.name) : undefined,
    steps,
    exceptionalStates: exceptionsFor(id, input.goal),
    antiCheckpoints: VENDOR_ANTI_CHECKPOINTS,
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
    .slice(0, 45);
  return slug || "capability";
}

function humanize(id: string): string {
  return id
    .split("-")
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}
