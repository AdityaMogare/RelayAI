import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startConsole, type ConsoleServer } from "../apps/bank-console/server.ts";
import { LOOKUP_MEMBER_SAVINGS } from "./fixtures.ts";
import { ControlPlane } from "../src/escalation/control.ts";
import { EvidenceStore } from "../src/evidence/store.ts";
import { MemoryVault } from "../src/policy/vault.ts";
import { ReplayEngine } from "../src/replay/engine.ts";
import { parseMoney } from "../src/replay/outputs.ts";
import { WebSurface } from "../src/surfaces/web.ts";
import type { Capability } from "../src/core/types.ts";

const SECRET = "vault-secret-NEVER-LOG-9xK";
const vault = new MemoryVault({
  "vault://tenant-9/teller": { username: "teller01", secret: SECRET },
});

function dumpDir(dir: string): string {
  const parts: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) continue;
    if (name.endsWith(".png")) continue;
    parts.push(readFileSync(path, "utf8"));
  }
  return parts.join("\n");
}

describe("legacy frameset, row locators, vault login, session death", () => {
  let modern: ConsoleServer;
  let legacy: ConsoleServer;
  let authed: ConsoleServer;

  beforeAll(async () => {
    modern = await startConsole(0);
    legacy = await startConsole(0);
    authed = await startConsole(0, {
      auth: true,
      users: [{ username: "teller01", secret: SECRET }],
    });
  });

  afterAll(async () => {
    await modern.close();
    await legacy.close();
    await authed.close();
  });

  it("extracts savings from sibling cells inside a frameset (top URL never becomes /member)", async () => {
    const surface = new WebSurface();
    await surface.launch();
    const evidence = new EvidenceStore("legacy-frameset", mkdtempSync(join(tmpdir(), "relay-")));
    try {
      const cap: Capability = {
        ...LOOKUP_MEMBER_SAVINGS,
        steps: LOOKUP_MEMBER_SAVINGS.steps.map((step) => {
          if (step.action === "navigate" && step.url) {
            return { ...step, url: `${step.url}?legacy=1`, checkpoint: { kind: "textIncludes", expect: "Member Lookup" } };
          }
          if (step.id === "s01-type") {
            return {
              ...step,
              target: {
                primary: { by: "css", selector: "input[name=mid]" },
                fallbacks: step.target?.fallbacks,
              },
            };
          }
          if (step.id === "s02-click") {
            return { ...step, checkpoint: { kind: "textIncludes", expect: "Savings Balance" } };
          }
          return step;
        }),
      };
      const result = await new ReplayEngine(surface, evidence).run(cap, {
        inputs: { memberId: "12345" },
        baseUrl: legacy.origin,
      });
      expect(result.status).toBe("success");
      expect(result.outputs.savingsBalance).toEqual(parseMoney("$4,250.00"));
      const observed = await surface.observe();
      expect(observed.url).not.toContain("/member/");
      expect(observed.text).toContain("Savings Balance");
    } finally {
      await surface.close();
    }
  });

  it("falls back when a generated ASP.NET id rotates, and flags needsRediscovery", async () => {
    const surface = new WebSurface();
    await surface.launch();
    const evidence = new EvidenceStore("legacy-drift", mkdtempSync(join(tmpdir(), "relay-")));
    try {
      await surface.act({ name: "navigate", url: `${legacy.origin}/member/12345?legacy=1` });
      const miss = await surface.act({
        name: "extract",
        target: {
          primary: { by: "css", selector: "#ctl00_ctl32_dgAcct_ctl99_lblVal" },
          fallbacks: [{ by: "role", role: "cell", name: "Savings Balance" }],
        },
      });
      expect(miss.ok).toBe(true);
      expect(miss.extracted).toBe("$4,250.00");
      expect(miss.usedLocator?.by).not.toBe("css");

      const cap: Capability = {
        ...LOOKUP_MEMBER_SAVINGS,
        preconditions: {
          ...LOOKUP_MEMBER_SAVINGS.preconditions,
          entryCheckpoint: { kind: "textIncludes", expect: "Savings Balance" },
        },
        steps: [
          {
            id: "s00-extract",
            action: "extract",
            target: {
              primary: { by: "css", selector: "#ctl00_ctl32_dgAcct_ctl99_lblVal" },
              fallbacks: [
                { by: "role", role: "cell", name: "Savings Balance" },
                { by: "text", text: "Savings Balance" },
              ],
            },
            outputName: "savingsBalance",
            risk: "safe",
            timeoutMs: 8000,
            retryBudget: 3,
          },
        ],
      };
      await surface.act({ name: "navigate", url: `${legacy.origin}/member/12345?legacy=1` });
      const result = await new ReplayEngine(surface, evidence).run(cap, {
        inputs: { memberId: "12345" },
        baseUrl: legacy.origin,
      });
      expect(result.status).toBe("success");
      expect(result.needsRediscovery).toBe(true);
      expect(result.confidence).toBeLessThan(1);
      expect(result.locatorHits?.some((hit) => hit.rank > 1)).toBe(true);
    } finally {
      await surface.close();
    }
  });

  it("opens a dispute via a parameterized cellInRow locator", async () => {
    const surface = new WebSurface();
    await surface.launch();
    const evidence = new EvidenceStore("legacy-row", mkdtempSync(join(tmpdir(), "relay-")));
    try {
      const cap: Capability = {
        ...LOOKUP_MEMBER_SAVINGS,
        id: "open-dispute-row",
        parameters: [
          { name: "memberId", type: "string" },
          { name: "disputeId", type: "string" },
        ],
        outputs: [
          {
            name: "transactionAmount",
            type: "money",
            pii: true,
            locator: {
              primary: { by: "role", role: "cell", name: "Transaction Amount" },
            },
          },
        ],
        uses: [],
        preconditions: {
          requiresSession: true,
          requiresRole: "teller",
          entryCheckpoint: { kind: "textIncludes", expect: "Member Lookup" },
        },
        success: { checkpoint: { kind: "textIncludes", expect: "Transaction Amount" } },
        steps: [
          {
            id: "s00-navigate",
            action: "navigate",
            url: "http://127.0.0.1:3000/",
            risk: "safe",
            checkpoint: { kind: "textIncludes", expect: "Member Lookup" },
            timeoutMs: 8000,
            retryBudget: 3,
          },
          {
            id: "s01-type",
            action: "type",
            target: { primary: { by: "role", role: "textbox", name: "Member ID" } },
            inputFrom: "parameters.memberId",
            risk: "safe",
            timeoutMs: 8000,
            retryBudget: 3,
          },
          {
            id: "s02-search",
            action: "click",
            target: { primary: { by: "role", role: "button", name: "Search" } },
            risk: "safe",
            checkpoint: { kind: "textIncludes", expect: "Savings Balance" },
            timeoutMs: 8000,
            retryBudget: 3,
          },
          {
            id: "s03-disputes",
            action: "click",
            target: { primary: { by: "role", role: "link", name: "Disputes" } },
            risk: "safe",
            checkpoint: { kind: "textIncludes", expect: "Dispute Queue" },
            timeoutMs: 8000,
            retryBudget: 3,
          },
          {
            id: "s04-row",
            action: "click",
            target: {
              primary: {
                by: "cellInRow",
                row: { matches: "{{parameters.disputeId}}" },
                cell: "Open",
              },
            },
            risk: "safe",
            checkpoint: { kind: "textIncludes", expect: "Transaction Amount" },
            timeoutMs: 8000,
            retryBudget: 3,
          },
          {
            id: "s05-extract",
            action: "extract",
            target: { primary: { by: "role", role: "cell", name: "Transaction Amount" } },
            outputName: "transactionAmount",
            risk: "safe",
            timeoutMs: 8000,
            retryBudget: 3,
          },
        ],
      };
      const result = await new ReplayEngine(surface, evidence).run(cap, {
        inputs: { memberId: "12345", disputeId: "DSP-1001" },
        baseUrl: modern.origin,
      });
      expect(result.status).toBe("success");
      expect(result.outputs.transactionAmount).toEqual(parseMoney("$42.18"));
    } finally {
      await surface.close();
    }
  });

  it("scopes a Member ID textbox to the Dispute Detail panel", async () => {
    const surface = new WebSurface();
    await surface.launch();
    try {
      await surface.act({ name: "navigate", url: `${legacy.origin}/member/12345?legacy=1` });
      const typed = await surface.act({
        name: "type",
        target: {
          primary: {
            by: "css",
            selector: "input[name=mid_dispute]",
            scope: { by: "region", heading: "Dispute Detail" },
          },
        },
        value: "scoped",
      });
      expect(typed.ok).toBe(true);
    } finally {
      await surface.close();
    }
  });

  it("paginates a last-name search of 14 Does in the frameset work pane", async () => {
    const surface = new WebSurface();
    await surface.launch();
    try {
      await surface.act({ name: "navigate", url: `${legacy.origin}/frames/work?last=Doe` });
      const page1 = await surface.observe();
      expect(page1.text).toContain("page 1 of 2");
      expect(page1.text).toContain("Jane Doe");
      expect(page1.text).toContain("Alan Doe");
      await surface.act({
        name: "click",
        target: { primary: { by: "role", role: "link", name: "Next" } },
      });
      const page2 = await surface.observe();
      expect(page2.text).toContain("page 2 of 2");
      expect(page2.text).toContain("Kurt Doe");
      expect(page2.text).toMatch(/Details/);
    } finally {
      await surface.close();
    }
  });

  it("types vault credentials and never writes the secret to evidence", async () => {
    const surface = new WebSurface();
    await surface.launch();
    const evidence = new EvidenceStore("legacy-vault", mkdtempSync(join(tmpdir(), "relay-")));
    try {
      const result = await new ReplayEngine(surface, evidence).run(LOOKUP_MEMBER_SAVINGS, {
        inputs: { memberId: "12345" },
        baseUrl: authed.origin,
        vault,
      });
      expect(result.status).toBe("success");
      expect(result.outputs.savingsBalance).toEqual(parseMoney("$4,250.00"));
      const dump = dumpDir(evidence.dir);
      expect(dump).not.toContain(SECRET);
      expect(dump).toContain("vault://tenant-9/teller");
    } finally {
      await surface.close();
    }
  });

  it("kills the session mid-flow, lets the operator re-auth, and resumes", async () => {
    const surface = new WebSurface();
    await surface.launch();
    const evidence = new EvidenceStore("legacy-expire", mkdtempSync(join(tmpdir(), "relay-")));
    try {
      const cap: Capability = {
        ...LOOKUP_MEMBER_SAVINGS,
        steps: LOOKUP_MEMBER_SAVINGS.steps.map((step) =>
          step.action === "navigate" && step.url
            ? { ...step, url: `${step.url}?expire-after=1` }
            : step,
        ),
      };
      const control = new ControlPlane(surface, evidence, async (_req, handle) => {
        handle.claim("teller01");
        handle.takeControl();
        await surface.actAsHuman({
          name: "click",
          target: { primary: { by: "role", role: "button", name: "Sign In" } },
        });
        await surface.actAsHuman({
          name: "type",
          target: { primary: { by: "role", role: "textbox", name: "Username" } },
          value: "teller01",
        });
        await surface.actAsHuman({
          name: "type",
          target: { primary: { by: "role", role: "textbox", name: "Password" } },
          value: SECRET,
        });
        await surface.actAsHuman({
          name: "click",
          target: { primary: { by: "role", role: "button", name: "Sign In" } },
        });
        await surface.actAsHuman({
          name: "type",
          target: { primary: { by: "role", role: "textbox", name: "Member ID" } },
          value: "12345",
        });
        return { action: "resume", operatorId: "teller01", stepDisposition: "not_done" };
      });
      const result = await new ReplayEngine(surface, evidence).run(cap, {
        inputs: { memberId: "12345" },
        baseUrl: authed.origin,
        vault,
        control,
      });
      expect(result.status).toBe("success");
      expect(result.outputs.savingsBalance).toEqual(parseMoney("$4,250.00"));
    } finally {
      await surface.close();
    }
  });
});
