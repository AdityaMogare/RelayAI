import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startConsole, type ConsoleServer } from "../apps/bank-console/server.ts";
import { CU_WEST_SKIN } from "../apps/bank-console/skins.ts";
import { DiscoveryAgent } from "../src/agent/discover.ts";
import { ScriptedLlm } from "../src/agent/providers.ts";
import {
  JANE_DOE_DISPUTE_GOAL,
  scriptedAssistedDiscovery,
  scriptedLookup,
  scriptedLookupStuckHelp,
} from "../src/agent/scripts.ts";
import { LOOKUP_MEMBER_SAVINGS, VERIFY_AND_FILE_DISPUTE } from "./fixtures.ts";
import { ControlPlane, humanCompletesRiskyStep } from "../src/escalation/control.ts";
import { FileArtifactStore, MemoryArtifactStore } from "../src/artifact/store.ts";
import { promoteHits, rankedTarget } from "../src/artifact/ranked.ts";
import { EvidenceStore } from "../src/evidence/store.ts";
import { bindTenant } from "../src/overlay/store.ts";
import { ReplayEngine } from "../src/replay/engine.ts";
import { probeApplicability } from "../src/replay/probe.ts";
import { hashFromLog } from "../src/replay/roundtrip.ts";
import { parseMoney } from "../src/replay/outputs.ts";
import { WebSurface } from "../src/surfaces/web.ts";

describe("playwright replay against the local console", () => {
  let consoleServer: ConsoleServer;

  beforeAll(async () => {
    consoleServer = await startConsole(0);
  });

  afterAll(async () => {
    await consoleServer.close();
  });

  beforeEach(() => {
    consoleServer.reset();
  });

  it("extracts a real savings balance", async () => {
    const surface = new WebSurface();
    await surface.launch();
    const evidence = new EvidenceStore("it-success", mkdtempSync(join(tmpdir(), "relay-")));
    try {
      const result = await new ReplayEngine(surface, evidence).run(LOOKUP_MEMBER_SAVINGS, {
        inputs: { memberId: "12345" },
        baseUrl: consoleServer.origin,
      });
      expect(result.status).toBe("success");
      expect(result.outputs?.savingsBalance).toEqual(parseMoney("$4,250.00"));
    } finally {
      await surface.close();
    }
  });

  it("classifies an unknown member as a business outcome", async () => {
    const surface = new WebSurface();
    await surface.launch();
    const evidence = new EvidenceStore("it-notfound", mkdtempSync(join(tmpdir(), "relay-")));
    try {
      const result = await new ReplayEngine(surface, evidence).run(LOOKUP_MEMBER_SAVINGS, {
        inputs: { memberId: "99999" },
        baseUrl: consoleServer.origin,
      });
      expect(result.status).toBe("business_outcome");
      expect(result.code).toBe("MEMBER_NOT_FOUND");
    } finally {
      await surface.close();
    }
  });

  it("files a seeded dispute and returns a confirmation", async () => {
    const surface = new WebSurface();
    await surface.launch();
    const evidence = new EvidenceStore("it-dispute", mkdtempSync(join(tmpdir(), "relay-")));
    try {
      const result = await new ReplayEngine(surface, evidence).run(VERIFY_AND_FILE_DISPUTE, {
        inputs: { memberId: "12345", merchant: "ACME POS", last4: "4412", reason: "Unauthorized" },
        baseUrl: consoleServer.origin,
        approveRisky: true,
      });
      expect(result.status).toBe("success");
      expect(result.outputs?.transactionAmount).toEqual(parseMoney("$42.18"));
      expect(result.outputs?.confirmation).toContain("CASE-77201");
    } finally {
      await surface.close();
    }
  });

  it("classifies an unknown dispute as a business outcome", async () => {
    const surface = new WebSurface();
    await surface.launch();
    const evidence = new EvidenceStore("it-dispute-missing", mkdtempSync(join(tmpdir(), "relay-")));
    try {
      const result = await new ReplayEngine(surface, evidence).run(VERIFY_AND_FILE_DISPUTE, {
        inputs: { memberId: "12345", merchant: "NO-SUCH", last4: "0000", reason: "Unauthorized" },
        baseUrl: consoleServer.origin,
        approveRisky: true,
      });
      expect(result.status).toBe("business_outcome");
      expect(result.code).toBe("DISPUTE_NOT_FOUND");
    } finally {
      await surface.close();
    }
  });

  it("extracts a table value even when the locator hits the rowheader", async () => {
    const surface = new WebSurface();
    await surface.launch();
    try {
      await surface.act({ name: "navigate", url: `${consoleServer.origin}/member/12345` });
      const result = await surface.act({
        name: "extract",
        target: { primary: { by: "role", role: "rowheader", name: "Savings Balance" } },
        outputName: "savingsBalance",
      });
      expect(result.ok).toBe(true);
      expect(result.extracted).toBe("$4,250.00");
    } finally {
      await surface.close();
    }
  });

  it("round-trips scripted discovery into a replay of the compiled file", async () => {
    const root = mkdtempSync(join(tmpdir(), "relay-it-roundtrip-"));
    const store = new FileArtifactStore(join(root, "capabilities"));
    const discoverSurface = new WebSurface();
    await discoverSurface.launch();
    let replaySurface: WebSurface | undefined;
    try {
      const discoverEvidence = new EvidenceStore("it-roundtrip-discover", join(root, "discover"));
      const discovered = await new DiscoveryAgent(
        discoverSurface,
        new ScriptedLlm(scriptedLookup()),
        store,
        discoverEvidence,
      ).run({
        goal: "Look up member 12345 and read their current savings balance",
        targetUrl: consoleServer.origin,
        capabilityId: "lookup-member-savings",
      });
      expect(discovered.result.status).toBe("success");
      expect(discovered.artifactPath).toBeDefined();
      const { capability, path, contentHash } = await store.loadWithHash(discovered.artifactPath!);
      await discoverSurface.close();

      replaySurface = new WebSurface();
      await replaySurface.launch();
      const replayEvidence = new EvidenceStore("it-roundtrip-replay", join(root, "replay"));
      const result = await new ReplayEngine(replaySurface, replayEvidence).run(capability, {
        inputs: { memberId: "12345" },
        baseUrl: consoleServer.origin,
        artifactPath: path,
        contentHash,
      });
      expect(result.status).toBe("success");
      expect(result.outputs.savingsBalance).toEqual(parseMoney("$4,250.00"));
      expect(result.needsRediscovery).toBe(false);
      const discoverHash = hashFromLog(join(discoverEvidence.dir, "log.jsonl"), "discover.end");
      const replayHash = hashFromLog(join(replayEvidence.dir, "log.jsonl"), "replay.start");
      expect(discoverHash).toBe(replayHash);
      expect(discoverHash).toBe(contentHash);
    } finally {
      await discoverSurface.close();
      await replaySurface?.close();
    }
  });

  it("dry-run files nothing and still returns the transaction amount", async () => {
    const surface = new WebSurface();
    await surface.launch();
    const evidence = new EvidenceStore("it-dry-run", mkdtempSync(join(tmpdir(), "relay-")));
    try {
      const result = await new ReplayEngine(surface, evidence).run(VERIFY_AND_FILE_DISPUTE, {
        inputs: { memberId: "12345", merchant: "ACME POS", last4: "4412", reason: "Unauthorized" },
        baseUrl: consoleServer.origin,
        dryRun: true,
      });
      expect(result.status).toBe("dry_run");
      expect(result.outputs.transactionAmount).toEqual(parseMoney("$42.18"));
      expect(result.wouldExecute?.some((step) => step.stepId === "s10-confirm")).toBe(true);
      const observed = await surface.observe();
      expect(observed.text).not.toContain("Dispute filed");
    } finally {
      await surface.close();
    }
  });

  it("dismisses a system notice and retries the same step", async () => {
    const surface = new WebSurface();
    await surface.launch();
    const evidence = new EvidenceStore("it-notice", mkdtempSync(join(tmpdir(), "relay-")));
    try {
      const cap = {
        ...LOOKUP_MEMBER_SAVINGS,
        steps: LOOKUP_MEMBER_SAVINGS.steps.map((step) =>
          step.action === "navigate" && step.url
            ? { ...step, url: `${step.url}?notice=1` }
            : step,
        ),
      };
      const result = await new ReplayEngine(surface, evidence).run(cap, {
        inputs: { memberId: "12345" },
        baseUrl: consoleServer.origin,
      });
      expect(result.status).toBe("success");
      expect(result.outputs.savingsBalance).toEqual(parseMoney("$4,250.00"));
    } finally {
      await surface.close();
    }
  });

  it("classifies session expiry as needs_human", async () => {
    const surface = new WebSurface();
    await surface.launch();
    const evidence = new EvidenceStore("it-expired", mkdtempSync(join(tmpdir(), "relay-")));
    try {
      const cap = {
        ...LOOKUP_MEMBER_SAVINGS,
        steps: LOOKUP_MEMBER_SAVINGS.steps.map((step) =>
          step.action === "navigate" && step.url
            ? { ...step, url: `${step.url}?expired=1` }
            : step,
        ),
      };
      const result = await new ReplayEngine(surface, evidence).run(cap, {
        inputs: { memberId: "12345" },
        baseUrl: consoleServer.origin,
      });
      expect(result.status).toBe("needs_human");
      expect(result.code).toBe("SESSION_EXPIRED");
    } finally {
      await surface.close();
    }
  });

  it("rejects an empty dispute amount even when the screen checkpoint holds", async () => {
    const surface = new WebSurface();
    await surface.launch();
    const evidence = new EvidenceStore("it-empty-amount", mkdtempSync(join(tmpdir(), "relay-")));
    try {
      const result = await new ReplayEngine(surface, evidence).run(VERIFY_AND_FILE_DISPUTE, {
        inputs: { memberId: "12345", merchant: "MAINFRAME TIMEOUT", last4: "4412", reason: "Unauthorized" },
        baseUrl: consoleServer.origin,
        approveRisky: true,
      });
      expect(result.status).toBe("failed");
      expect(result.code).toBe("OUTPUT_INVALID");
      expect(result.stepId).toBe("s06-extract-amount");
    } finally {
      await surface.close();
    }
  });
});

describe("one artifact, two skins", () => {
  it("replays lookup-member-savings against CU West via the tenant-14 overlay", async () => {
    const west = await startConsole(0, { skin: CU_WEST_SKIN });
    const surface = new WebSurface();
    await surface.launch();
    const evidence = new EvidenceStore("it-cu-west", mkdtempSync(join(tmpdir(), "relay-")));
    try {
      const bound = bindTenant(LOOKUP_MEMBER_SAVINGS, "tenant-14", { baseUrl: west.origin });
      const probe = await probeApplicability(surface, bound.capability, {
        baseUrl: west.origin,
        inputs: { memberId: "12345" },
      });
      expect(probe.applicable).toBe(true);
      const result = await new ReplayEngine(surface, evidence).run(bound.capability, {
        inputs: { memberId: "12345" },
        baseUrl: west.origin,
        tenantId: "tenant-14",
        overlayTrace: bound.trace,
      });
      expect(result.status).toBe("success");
      expect(result.needsRediscovery).toBe(false);
      expect(result.outputs?.savingsBalance).toEqual(parseMoney("$4,250.00"));
      expect(bound.trace.copy.Search).toBe("Find Member");
    } finally {
      await surface.close();
      await west.close();
    }
  });

  it("refuses the recorded artifact on CU West without an overlay", async () => {
    const west = await startConsole(0, { skin: CU_WEST_SKIN });
    const surface = new WebSurface();
    await surface.launch();
    try {
      const probe = await probeApplicability(surface, LOOKUP_MEMBER_SAVINGS, {
        baseUrl: west.origin,
        inputs: { memberId: "12345" },
      });
      expect(probe.applicable).toBe(false);
    } finally {
      await surface.close();
      await west.close();
    }
  });
});

describe("human handoff does not double-file", () => {
  it("writes exactly one filings row when the operator confirms and automation skips", async () => {
    const isolated = await startConsole(0);
    isolated.reset();
    const surface = new WebSurface();
    await surface.launch();
    const evidence = new EvidenceStore("it-handoff", mkdtempSync(join(tmpdir(), "relay-")));
    try {
      const control = new ControlPlane(
        surface,
        evidence,
        humanCompletesRiskyStep("teller01", async () => {
          const clicked = await surface.actAsHuman({
            name: "click",
            target: { primary: { by: "role", role: "button", name: "Confirm" } },
          });
          expect(clicked.ok).toBe(true);
        }),
      );
      const result = await new ReplayEngine(surface, evidence).run(VERIFY_AND_FILE_DISPUTE, {
        inputs: { memberId: "12345", merchant: "ACME POS", last4: "4412", reason: "Unauthorized" },
        baseUrl: isolated.origin,
        control,
      });
      expect(result.status, `${result.code} ${result.message}`).toBe("success");
      const sql = "SELECT count(*) FROM filings WHERE dispute_id='DSP-1001'";
      expect(isolated.filings.exec(sql).count).toBe(1);
      expect(control.lastIntervention?.operatorKind).toBe("scripted");
      const lines = readFileSync(join(evidence.dir, "log.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { kind: string; data: Record<string, unknown> });
      const reconcile = lines.find((e) => e.kind === "replay.reconcile");
      expect(reconcile?.data).toMatchObject({ skip: true, checkpointHeld: true, stepDisposition: "completed_by_human" });
      expect(lines.some((e) => e.kind === "replay.step" && e.data.stepId === "s10-confirm")).toBe(false);
      expect(control.lastIntervention?.operatorId).toBe("teller01");
      expect(control.lastIntervention?.state).toBe("resolved");
    } finally {
      await surface.close();
      await isolated.close();
    }
  });
});

function lastNameLookup() {
  const nav = LOOKUP_MEMBER_SAVINGS.steps.find((step) => step.action === "navigate")!;
  const extract = LOOKUP_MEMBER_SAVINGS.steps.find((step) => step.action === "extract")!;
  return {
    ...LOOKUP_MEMBER_SAVINGS,
    id: "lookup-member-by-last-name",
    parameters: [
      { name: "lastName", type: "string" as const, description: "Last name", sensitive: false },
      { name: "memberId", type: "string" as const, description: "Row", sensitive: false },
    ],
    steps: [
      nav,
      {
        id: "s01-type-last",
        action: "type" as const,
        target: rankedTarget("textbox", "Last Name"),
        inputFrom: "parameters.lastName",
        risk: "safe" as const,
        timeoutMs: 8000,
        retryBudget: 3,
      },
      {
        id: "s02-search",
        action: "click" as const,
        target: rankedTarget("button", "Search"),
        risk: "safe" as const,
        checkpoint: { kind: "textIncludes" as const, expect: "members named" },
        timeoutMs: 8000,
        retryBudget: 3,
      },
      {
        id: "s03-open",
        action: "click" as const,
        target: rankedTarget("link", "Open", { by: "row", hasText: [":memberId"] }),
        risk: "safe" as const,
        checkpoint: { kind: "urlIncludes" as const, expect: "/member" },
        timeoutMs: 8000,
        retryBudget: 3,
      },
      { ...extract, id: "s04-extract" },
    ],
  };
}

describe("coverage exhibits", () => {
  let consoleServer: ConsoleServer;

  beforeAll(async () => {
    consoleServer = await startConsole(0);
  });

  afterAll(async () => {
    await consoleServer.close();
  });

  beforeEach(() => {
    consoleServer.reset();
  });

  it("aborts GET /admin/wire at the Playwright route layer", async () => {
    const surface = new WebSurface();
    await surface.launch();
    const evidence = new EvidenceStore("it-wire", mkdtempSync(join(tmpdir(), "relay-")));
    try {
      const nav = LOOKUP_MEMBER_SAVINGS.steps.find((step) => step.action === "navigate")!;
      const result = await new ReplayEngine(surface, evidence).run(
        {
          ...LOOKUP_MEMBER_SAVINGS,
          id: "probe-admin-wire",
          outputs: [],
          steps: [
            nav,
            {
              id: "s01-wire",
              action: "click",
              target: rankedTarget("link", "Wire Transfer"),
              risk: "safe",
              timeoutMs: 8000,
              retryBudget: 1,
            },
          ],
          success: { checkpoint: { kind: "textIncludes", expect: "unreachable" } },
        },
        { inputs: { memberId: "12345" }, baseUrl: consoleServer.origin },
      );
      expect(result.status).toBe("failed");
      expect(result.code).toBe("POLICY_VIOLATION");
      const log = readFileSync(join(evidence.dir, "log.jsonl"), "utf8");
      expect(log).toContain("policy.blocked");
      expect(log).toContain("/admin/wire");
    } finally {
      await surface.close();
    }
  });

  it("selects Jane Doe among 14 last-name hits by memberId", async () => {
    const html = await fetch(`${consoleServer.origin}/search?last=Doe`).then((r) => r.text());
    expect(html.match(/<a href="\/member\/[^"]+">Open<\/a>/g)?.length).toBe(10);
    expect(html).toContain("14 members named Doe");
    expect(html).toContain("page 1 of 2");
    expect(html.indexOf("Jane Doe")).toBeLessThan(html.indexOf("Alan Doe"));
    const surface = new WebSurface();
    await surface.launch();
    const evidence = new EvidenceStore("it-doe", mkdtempSync(join(tmpdir(), "relay-")));
    try {
      const result = await new ReplayEngine(surface, evidence).run(lastNameLookup(), {
        inputs: { lastName: "Doe", memberId: "12345" },
        baseUrl: consoleServer.origin,
      });
      expect(result.status).toBe("success");
      expect(result.outputs?.savingsBalance).toEqual(parseMoney("$4,250.00"));
    } finally {
      await surface.close();
    }
  });

  it("resumes after mid-run expiry when the operator signs in", async () => {
    const surface = new WebSurface();
    await surface.launch();
    const evidence = new EvidenceStore("it-reauth", mkdtempSync(join(tmpdir(), "relay-")));
    try {
      const nav = LOOKUP_MEMBER_SAVINGS.steps.map((step) =>
        step.action === "navigate" && step.url
          ? { ...step, url: `${step.url}${step.url.includes("?") ? "&" : "?"}expireMid=1` }
          : step,
      );
      const control = new ControlPlane(
        surface,
        evidence,
        humanCompletesRiskyStep("teller01", async () => {
          const clicked = await surface.actAsHuman({
            name: "click",
            target: { primary: { by: "role", role: "button", name: "Sign In" } },
          });
          expect(clicked.ok).toBe(true);
          await surface.actAsHuman({
            name: "type",
            target: { primary: { by: "role", role: "textbox", name: "Member ID" } },
            value: "12345",
          });
        }),
      );
      const result = await new ReplayEngine(surface, evidence).run(
        { ...LOOKUP_MEMBER_SAVINGS, steps: nav },
        { inputs: { memberId: "12345" }, baseUrl: consoleServer.origin, control },
      );
      expect(result.status).toBe("success");
      expect(result.outputs?.savingsBalance).toEqual(parseMoney("$4,250.00"));
      const log = readFileSync(join(evidence.dir, "log.jsonl"), "utf8");
      expect(log).toContain("replay.reauth");
    } finally {
      await surface.close();
    }
  });

  it("extracts through a rank-3 text fallback then recovers via promoteHits", async () => {
    const surface = new WebSurface();
    await surface.launch();
    const evidence = new EvidenceStore("it-rank3", mkdtempSync(join(tmpdir(), "relay-")));
    try {
      const poisoned = {
        ...LOOKUP_MEMBER_SAVINGS,
        steps: LOOKUP_MEMBER_SAVINGS.steps.map((step) =>
          step.action === "extract"
            ? {
                ...step,
                target: {
                  primary: { by: "role" as const, role: "cell", name: "Savins Balance" },
                  fallbacks: [
                    { by: "label" as const, name: "Savins Balance" },
                    { by: "text" as const, text: "Savings Balance" },
                    { by: "css" as const, selector: '[aria-label="Savins Balance"]' },
                  ],
                },
              }
            : step,
        ),
      };
      const degraded = await new ReplayEngine(surface, evidence).run(poisoned, {
        inputs: { memberId: "12345" },
        baseUrl: consoleServer.origin,
      });
      expect(degraded.status).toBe("success");
      expect(degraded.needsRediscovery).toBe(true);
      expect(degraded.locatorHits?.some((hit) => hit.stepId === "s03-extract" && hit.rank === 3)).toBe(true);
      const v2 = promoteHits(poisoned, degraded.locatorHits ?? []);
      const recovered = await new ReplayEngine(surface, evidence).run(v2, {
        inputs: { memberId: "12345" },
        baseUrl: consoleServer.origin,
      });
      expect(recovered.status).toBe("success");
      expect(recovered.needsRediscovery).toBe(false);
      expect(recovered.confidence).toBe(1);
    } finally {
      await surface.close();
    }
  });

  it("discovers lookup inside a real frameset", async () => {
    const surface = new WebSurface();
    await surface.launch();
    const evidence = new EvidenceStore("it-frameset-discover", mkdtempSync(join(tmpdir(), "relay-")));
    const store = new MemoryArtifactStore();
    try {
      const out = await new DiscoveryAgent(surface, new ScriptedLlm(scriptedLookup()), store, evidence).run({
        goal: "Look up member 12345 and read their current savings balance",
        targetUrl: `${consoleServer.origin}/?legacy=1`,
        capabilityId: "lookup-frameset",
      });
      expect(out.result.status).toBe("success");
      expect(String(out.result.outputs?.savingsBalance)).toMatch(/4,250/);
    } finally {
      await surface.close();
    }
  }, 45_000);

  it("replays lookup through a real frameset", async () => {
    const surface = new WebSurface();
    await surface.launch();
    const evidence = new EvidenceStore("it-frameset", mkdtempSync(join(tmpdir(), "relay-")));
    try {
      const cap = {
        ...LOOKUP_MEMBER_SAVINGS,
        steps: LOOKUP_MEMBER_SAVINGS.steps.map((step) => {
          if (step.action === "navigate" && step.url) {
            return { ...step, url: `${step.url}?legacy=1`, checkpoint: { kind: "textIncludes" as const, expect: "Member Lookup" } };
          }
          if (step.id === "s02-click") {
            return { ...step, checkpoint: { kind: "textIncludes" as const, expect: "Savings Balance" } };
          }
          return step;
        }),
      };
      const result = await new ReplayEngine(surface, evidence).run(cap, {
        inputs: { memberId: "12345" },
        baseUrl: consoleServer.origin,
      });
      expect(result.status).toBe("success");
      expect(result.outputs?.savingsBalance).toEqual(parseMoney("$4,250.00"));
    } finally {
      await surface.close();
    }
  }, 45_000);

  it("records assistedBy when a human unsticks Help-mashing discovery", async () => {
    const surface = new WebSurface();
    await surface.launch();
    const evidence = new EvidenceStore("it-assist-help", mkdtempSync(join(tmpdir(), "relay-")));
    const store = new MemoryArtifactStore();
    try {
      const control = new ControlPlane(
        surface,
        evidence,
        humanCompletesRiskyStep("teller01", async () => {
          const seen = await surface.observe();
          if (/Savings Balance/i.test(seen.text)) return;
          await surface.actAsHuman({
            name: "type",
            target: { primary: { by: "role", role: "textbox", name: "Member ID" } },
            value: "12345",
          });
          const clicked = await surface.actAsHuman({
            name: "click",
            target: { primary: { by: "role", role: "button", name: "Search" } },
          });
          if (!clicked.ok) throw new Error(clicked.error ?? "operator Search failed");
        }),
      );
      const out = await new DiscoveryAgent(surface, new ScriptedLlm(scriptedLookupStuckHelp()), store, evidence).run({
        goal: "Look up member 12345 and read their current savings balance",
        targetUrl: `${consoleServer.origin}/`,
        capabilityId: "lookup-assisted",
        control,
        maxSteps: 16,
      });
      expect(out.result.status).toBe("success");
      expect(out.artifact?.provenance.assistedBy).toBe("teller01");
      expect(out.artifact?.steps.some((s) => s.assistedBy === "teller01")).toBe(true);
    } finally {
      await surface.close();
    }
  }, 45_000);

  it("resumes after a supervisor attestation and stamps assistedBy", async () => {
    const surface = new WebSurface();
    await surface.launch();
    const evidence = new EvidenceStore("it-assist-attest", mkdtempSync(join(tmpdir(), "relay-")));
    const store = new MemoryArtifactStore();
    try {
      const control = new ControlPlane(
        surface,
        evidence,
        humanCompletesRiskyStep("teller01", async () => {
          const seen = await surface.observe();
          const name = seen.refs.some((ref) => ref.name === "I attest") ? "I attest" : "Confirm";
          const clicked = await surface.actAsHuman({
            name: "click",
            target: { primary: { by: "role", role: "button", name } },
          });
          if (!clicked.ok) throw new Error(clicked.error ?? `operator ${name} failed`);
        }),
      );
      const out = await new DiscoveryAgent(
        surface,
        new ScriptedLlm(scriptedAssistedDiscovery()),
        store,
        evidence,
      ).run({
        goal: JANE_DOE_DISPUTE_GOAL,
        targetUrl: `${consoleServer.origin}/?attest=1`,
        capabilityId: "verify-and-file-dispute-assisted",
        control,
        maxSteps: 20,
      });
      expect(out.result.status).toBe("success");
      expect(out.artifact?.provenance.assistedBy).toBe("teller01");
      expect(out.artifact?.steps.some((s) => s.assistedBy === "teller01" && s.target?.primary.name === "I attest")).toBe(
        true,
      );
    } finally {
      await surface.close();
    }
  }, 45_000);
});
