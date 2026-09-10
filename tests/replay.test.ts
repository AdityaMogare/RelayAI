import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LOOKUP_MEMBER_SAVINGS, OPEN_SUB_ACCOUNT, VERIFY_AND_FILE_DISPUTE, WESTSIDE_LABELS } from "./fixtures.ts";
import { bindTenant } from "../src/overlay/store.ts";
import { ControlPlane, immediateAbort, immediateResume } from "../src/escalation/control.ts";
import { EvidenceStore } from "../src/evidence/store.ts";
import { ReplayEngine } from "../src/replay/engine.ts";
import { MemoryRunLedger } from "../src/replay/ledger.ts";
import { parseMoney } from "../src/replay/outputs.ts";
import { MockSurface } from "../src/surfaces/mock.ts";

function harness(start?: ConstructorParameters<typeof MockSurface>[0]) {
  const surface = new MockSurface(start);
  const evidence = new EvidenceStore(`test-${Math.random().toString(16).slice(2)}`, mkdtempSync(join(tmpdir(), "relay-")));
  const engine = new ReplayEngine(surface, evidence);
  return { surface, evidence, engine };
}

describe("replay taxonomy", () => {
  it("returns outputs on the happy path", async () => {
    const { engine } = harness();
    const result = await engine.run(LOOKUP_MEMBER_SAVINGS, { inputs: { memberId: "12345" } });
    expect(result.status).toBe("success");
    expect(result.outputs?.savingsBalance).toEqual(parseMoney("$4,250.00"));
  });

  it("treats member-not-found as a business outcome", async () => {
    const { engine } = harness();
    const result = await engine.run(LOOKUP_MEMBER_SAVINGS, { inputs: { memberId: "99999" } });
    expect(result.status).toBe("business_outcome");
    expect(result.code).toBe("MEMBER_NOT_FOUND");
  });

  it("treats a restricted member as a business outcome", async () => {
    const { engine } = harness();
    const result = await engine.run(LOOKUP_MEMBER_SAVINGS, { inputs: { memberId: "55555" } });
    expect(result.status).toBe("business_outcome");
    expect(result.code).toBe("PERMISSION_DENIED");
  });

  it("dismisses a known interstitial and continues", async () => {
    const { engine } = harness("notice");
    const result = await engine.run(LOOKUP_MEMBER_SAVINGS, { inputs: { memberId: "12345" } });
    expect(result.status).toBe("success");
    expect(result.outputs?.savingsBalance).toEqual(parseMoney("$4,250.00"));
  });

  it("stops on session expiry as needs_human, not a locator ticket", async () => {
    const { engine } = harness();
    const result = await engine.run(LOOKUP_MEMBER_SAVINGS, { inputs: { memberId: "00000" } });
    expect(result.status).toBe("needs_human");
    expect(result.classify).toBe("needs_human");
    expect(result.code).toBe("SESSION_EXPIRED");
  });

  it("reports a locator miss as a debuggable hard failure", async () => {
    const { engine, surface } = harness();
    surface.failNextLocator = true;
    const result = await engine.run(LOOKUP_MEMBER_SAVINGS, { inputs: { memberId: "12345" } });
    expect(result.status).toBe("failed");
    expect(result.classify).toBe("hard_failure");
    expect(result.code).toBe("LOCATOR_MISS");
    expect(result.stepId).toBeDefined();
    expect(result.expected).toBeDefined();
    expect(result.observed).toBeDefined();
  });

  it("blocks a risky confirm unless approved or escalated", async () => {
    const { engine } = harness();
    const result = await engine.run(OPEN_SUB_ACCOUNT, {
      inputs: { memberId: "12345", product: "Share Savings" },
    });
    expect(result.status).toBe("escalated");
    expect(result.code).toBe("RISKY_ACTION_BLOCKED");
  });

  it("continues a risky step after a human resume", async () => {
    const { engine, surface, evidence } = harness();
    const control = new ControlPlane(surface, evidence, immediateResume("clicked confirm"));
    const result = await engine.run(OPEN_SUB_ACCOUNT, {
      inputs: { memberId: "12345", product: "Share Savings" },
      control,
    });
    expect(result.status).toBe("success");
    expect(control.lastHumanNote).toContain("clicked confirm");
  });

  it("records an abort as escalated", async () => {
    const { engine, surface, evidence } = harness();
    const control = new ControlPlane(surface, evidence, immediateAbort("no"));
    const result = await engine.run(OPEN_SUB_ACCOUNT, {
      inputs: { memberId: "12345", product: "Share Savings" },
      control,
    });
    expect(result.status).toBe("escalated");
    expect(result.interventionId).toBeDefined();
  });

  it("files an open dispute when the risky confirm is approved", async () => {
    const { engine } = harness();
    const result = await engine.run(VERIFY_AND_FILE_DISPUTE, {
      inputs: { memberId: "12345", merchant: "ACME POS", last4: "4412", reason: "Unauthorized" },
      approveRisky: true,
    });
    expect(result.status).toBe("success");
    expect(result.outputs?.transactionAmount).toEqual(parseMoney("$42.18"));
    expect(result.outputs?.confirmation).toContain("CASE-77201");
  });

  it("classifies a missing dispute as a business outcome", async () => {
    const { engine } = harness();
    const result = await engine.run(VERIFY_AND_FILE_DISPUTE, {
      inputs: { memberId: "12345", merchant: "NO-SUCH", last4: "0000", reason: "Unauthorized" },
      approveRisky: true,
    });
    expect(result.status).toBe("business_outcome");
    expect(result.code).toBe("DISPUTE_NOT_FOUND");
  });

  it("classifies an already-filed dispute as a business outcome", async () => {
    const { engine } = harness();
    const result = await engine.run(VERIFY_AND_FILE_DISPUTE, {
      inputs: { memberId: "12345", merchant: "NORTHSIDE FUEL", last4: "4412", reason: "Unauthorized" },
      approveRisky: true,
    });
    expect(result.status).toBe("business_outcome");
    expect(result.code).toBe("DISPUTE_ALREADY_FILED");
  });

  it("returns INVALID_INPUT for a missing parameter instead of uncaught", async () => {
    const { engine } = harness();
    const result = await engine.run(LOOKUP_MEMBER_SAVINGS, { inputs: {} });
    expect(result.status).toBe("invalid_input");
    expect(result.code).toBe("INVALID_INPUT");
    expect(result.stepId).toBeUndefined();
    expect(result.message).toMatch(/memberId/);
  });

  it("returns INVALID_INPUT for a mistyped parameter name", async () => {
    const { engine } = harness();
    const result = await engine.run(LOOKUP_MEMBER_SAVINGS, { inputs: { memberID: "12345" } });
    expect(result.status).toBe("invalid_input");
    expect(result.code).toBe("INVALID_INPUT");
    expect(result.observed).toBe("memberID");
  });

  it("returns INVALID_INPUT for a non-numeric number parameter", async () => {
    const { engine } = harness();
    const numbered = {
      ...LOOKUP_MEMBER_SAVINGS,
      parameters: [{ ...LOOKUP_MEMBER_SAVINGS.parameters[0]!, type: "number" as const }],
    };
    const result = await engine.run(numbered, { inputs: { memberId: "jane" } });
    expect(result.status).toBe("invalid_input");
    expect(result.message).toMatch(/number/);
    expect(result.violations).toEqual([
      { path: "parameters.memberId", expected: "number", observed: "jane" },
    ]);
    expect(result.stepId).toBeUndefined();
  });

  it("skips a risky step when the human already completed the checkpoint", async () => {
    const { engine, surface, evidence } = harness();
    const control = new ControlPlane(surface, evidence, async () => {
      surface.page = "opened";
      return { action: "resume", note: "operator clicked Confirm", stepCompletedByHuman: true };
    });
    const result = await engine.run(OPEN_SUB_ACCOUNT, {
      inputs: { memberId: "12345", product: "Share Savings" },
      control,
    });
    expect(result.status).toBe("success");
    const lines = readFileSync(join(evidence.dir, "log.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { kind: string; data: Record<string, unknown> });
    const reconcile = lines.find((e) => e.kind === "replay.reconcile");
    expect(reconcile?.data).toMatchObject({ skip: true, checkpointHeld: true, stepCompletedByHuman: true });
    expect(lines.some((e) => e.kind === "replay.step" && e.data.stepId === "s06-confirm")).toBe(false);
  });

  it("records rank-1 locator hits and does not flag a clean run", async () => {
    const { engine } = harness();
    const result = await engine.run(LOOKUP_MEMBER_SAVINGS, { inputs: { memberId: "12345" } });
    expect(result.status).toBe("success");
    expect(result.needsRediscovery).toBe(false);
    expect(result.confidence).toBe(1);
    expect(result.locatorHits?.every((hit) => hit.rank === 1)).toBe(true);
    expect(result.locatorHits?.some((hit) => hit.stepId === "s02-click" && hit.by === "role")).toBe(true);
  });

  it("flags a run that fell back below rank 1 and lowers confidence", async () => {
    const { engine, surface, evidence } = harness();
    surface.skipPrimary = true;
    const result = await engine.run(LOOKUP_MEMBER_SAVINGS, { inputs: { memberId: "12345" } });
    expect(result.status).toBe("success");
    expect(result.needsRediscovery).toBe(true);
    expect(result.confidence).toBeLessThan(1);
    expect(result.locatorHits?.some((hit) => hit.rank > 1)).toBe(true);
    const lines = readFileSync(join(evidence.dir, "log.jsonl"), "utf8");
    expect(lines).toContain("replay.drift");
    expect(lines).toContain('"fellBack":true');
  });

  it("dry-run stops before Confirm and reports what would happen", async () => {
    const { engine } = harness();
    const result = await engine.run(VERIFY_AND_FILE_DISPUTE, {
      inputs: { memberId: "12345", merchant: "ACME POS", last4: "4412", reason: "Unauthorized" },
      dryRun: true,
    });
    expect(result.status).toBe("dry_run");
    expect(result.outputs.transactionAmount).toEqual(parseMoney("$42.18"));
    expect(result.outputs.confirmation).toBeUndefined();
    expect(result.wouldExecute?.some((step) => step.stepId === "s10-confirm" && step.risk === "risky")).toBe(true);
    expect(result.stepId).toBe("s10-confirm");
  });

  it("returns outputs extracted so far when a later step fails", async () => {
    const { engine, surface } = harness();
    surface.failWhenName = "Confirm";
    const result = await engine.run(VERIFY_AND_FILE_DISPUTE, {
      inputs: { memberId: "12345", merchant: "ACME POS", last4: "4412", reason: "Unauthorized" },
      approveRisky: true,
    });
    expect(result.status).toBe("failed");
    expect(result.outputs.transactionAmount).toEqual(parseMoney("$42.18"));
    expect(result.outputs.confirmation).toBeUndefined();
  });

  it("returns empty outputs on every terminal status including invalid_input", async () => {
    const { engine } = harness();
    const result = await engine.run(LOOKUP_MEMBER_SAVINGS, { inputs: {} });
    expect(result.status).toBe("invalid_input");
    expect(result.outputs).toEqual({});
  });

  it("executes a risky step after resume when the checkpoint does not hold", async () => {
    const { engine, surface, evidence } = harness();
    const control = new ControlPlane(surface, evidence, immediateResume("auto-resume"));
    const result = await engine.run(OPEN_SUB_ACCOUNT, {
      inputs: { memberId: "12345", product: "Share Savings" },
      control,
    });
    expect(result.status).toBe("success");
    const lines = readFileSync(join(evidence.dir, "log.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { kind: string; data: Record<string, unknown> });
    const reconcile = lines.find((e) => e.kind === "replay.reconcile");
    expect(reconcile?.data).toMatchObject({ skip: false, checkpointHeld: false });
    expect(lines.some((e) => e.kind === "replay.step" && e.data.stepId === "s06-confirm")).toBe(true);
    expect(control.lastHumanNote).toBe("auto-resume");
  });

  it("skips Confirm when the operator already filed, even if they marked not_done", async () => {
    const { engine, surface, evidence } = harness();
    const control = new ControlPlane(surface, evidence, async (_req, handle) => {
      handle.claim("teller01");
      handle.takeControl();
      await surface.actAsHuman({
        name: "click",
        target: { primary: { by: "role", role: "button", name: "Confirm" } },
      });
      return { action: "resume", operatorId: "teller01", stepDisposition: "not_done" };
    });
    const result = await engine.run(VERIFY_AND_FILE_DISPUTE, {
      inputs: { memberId: "12345", merchant: "ACME POS", last4: "4412", reason: "Unauthorized" },
      control,
    });
    expect(result.status).toBe("success");
    const lines = readFileSync(join(evidence.dir, "log.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { kind: string; data: Record<string, unknown> });
    const reconcile = lines.find((e) => e.kind === "replay.reconcile");
    expect(reconcile?.data).toMatchObject({ skip: true, checkpointHeld: true, stepDisposition: "not_done" });
    expect(lines.some((e) => e.kind === "replay.step" && e.data.stepId === "s10-confirm")).toBe(false);
    expect(control.lastIntervention?.operatorId).toBe("teller01");
    expect(control.lastIntervention?.state).toBe("resolved");
  });

  it("does not execute Confirm if the operator navigated away", async () => {
    const { engine, surface, evidence } = harness();
    const control = new ControlPlane(surface, evidence, async (_req, handle) => {
      handle.claim("teller01");
      handle.takeControl();
      surface.page = "detail";
      return { action: "resume", operatorId: "teller01", stepDisposition: "not_done" };
    });
    const result = await engine.run(OPEN_SUB_ACCOUNT, {
      inputs: { memberId: "12345", product: "Share Savings" },
      control,
    });
    expect(result.status).toBe("needs_human");
    expect(result.code).toBe("PRECONDITION_LOST");
    expect(control.lastIntervention?.state).toBe("abandoned");
    const lines = readFileSync(join(evidence.dir, "log.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { kind: string; data: Record<string, unknown> });
    expect(lines.some((e) => e.kind === "replay.step" && e.data.stepId === "s06-confirm")).toBe(false);
  });

  it("exhausts recoverable retries and files needs_human when the interstitial always returns", async () => {
    const { engine, surface, evidence } = harness("notice");
    surface.stickyNotice = true;
    const result = await engine.run(LOOKUP_MEMBER_SAVINGS, { inputs: { memberId: "12345" } });
    expect(result.status).toBe("needs_human");
    expect(result.code).toBe("RECOVERABLE_EXHAUSTED");
    const lines = readFileSync(join(evidence.dir, "log.jsonl"), "utf8");
    expect(lines).toContain("replay.retry");
    expect(lines).toContain('"class":"recoverable"');
    expect(lines).toContain('"sameStep":true');
  });

  it("never retries a deterministic locator miss", async () => {
    const { engine, surface, evidence } = harness();
    surface.failNextLocator = true;
    const result = await engine.run(LOOKUP_MEMBER_SAVINGS, { inputs: { memberId: "12345" } });
    expect(result.status).toBe("failed");
    expect(result.code).toBe("LOCATOR_MISS");
    const lines = readFileSync(join(evidence.dir, "log.jsonl"), "utf8");
    expect(lines).not.toContain("replay.retry");
  });

  it("retries a transient 503 with backoff then succeeds", async () => {
    const { engine, surface, evidence } = harness();
    surface.failTransientTimes = 2;
    const result = await engine.run(LOOKUP_MEMBER_SAVINGS, {
      inputs: { memberId: "12345" },
      backoffMs: [0, 0, 0],
    });
    expect(result.status).toBe("success");
    const lines = readFileSync(join(evidence.dir, "log.jsonl"), "utf8");
    expect(lines).toContain('"class":"transient"');
  });

  it("fails anti-checkpoint when the page is the wrong screen", async () => {
    const { engine } = harness("wrong");
    const result = await engine.run(LOOKUP_MEMBER_SAVINGS, { inputs: { memberId: "12345" } });
    expect(result.status).toBe("failed");
    expect(result.code).toBe("ANTI_CHECKPOINT");
    expect(result.classify).toBe("hard_failure");
  });

  it("fails OUTPUT_INVALID when the dispute amount cell is empty", async () => {
    const { engine } = harness();
    const result = await engine.run(VERIFY_AND_FILE_DISPUTE, {
      inputs: { memberId: "12345", merchant: "MAINFRAME TIMEOUT", last4: "4412", reason: "Unauthorized" },
      approveRisky: true,
    });
    expect(result.status).toBe("failed");
    expect(result.code).toBe("OUTPUT_INVALID");
    expect(result.stepId).toBe("s06-extract-amount");
    expect(result.observed).toBe("(empty)");
  });

  it("marks a risky checkpoint miss as ambiguous and keyed", async () => {
    const { engine, surface } = harness();
    const control = new ControlPlane(surface, new EvidenceStore("amb", mkdtempSync(join(tmpdir(), "relay-"))), immediateResume("auto-resume"));
    surface.failWhenName = undefined;
    const mutated = {
      ...OPEN_SUB_ACCOUNT,
      steps: OPEN_SUB_ACCOUNT.steps.map((step) =>
        step.id === "s06-confirm"
          ? { ...step, checkpoint: { kind: "textIncludes" as const, expect: "this confirmation never appears" } }
          : step,
      ),
    };
    const result = await engine.run(mutated, {
      inputs: { memberId: "12345", product: "Share Savings" },
      control,
    });
    expect(result.status).toBe("failed");
    expect(result.code).toBe("CHECKPOINT_AFTER_ACT");
    expect(result.ambiguous).toBe(true);
    expect(result.idempotencyKey).toBeDefined();
  });

  it("refuses a wrong role before step 1", async () => {
    const { engine } = harness();
    const result = await engine.run(LOOKUP_MEMBER_SAVINGS, {
      inputs: { memberId: "12345" },
      session: { authenticated: true, role: "customer" },
    });
    expect(result.status).toBe("failed");
    expect(result.code).toBe("PRECONDITION_FAILED");
    expect(result.stepId).toBeUndefined();
  });

  it("stops a composed capability at the door when the member screen is missing", async () => {
    const { engine } = harness();
    const orphan = { ...VERIFY_AND_FILE_DISPUTE, uses: [] };
    const result = await engine.run(orphan, {
      inputs: { memberId: "12345", merchant: "ACME POS", last4: "4412", reason: "Unauthorized" },
      approveRisky: true,
    });
    expect(result.status).toBe("failed");
    expect(result.code).toBe("PRECONDITION_FAILED");
    expect(result.stepId).toBe("precondition");
  });

  it("composes lookup-member as a primitive instead of re-recording search", async () => {
    const { engine, evidence } = harness();
    const result = await engine.run(VERIFY_AND_FILE_DISPUTE, {
      inputs: { memberId: "12345", merchant: "ACME POS", last4: "4412", reason: "Unauthorized" },
      approveRisky: true,
    });
    expect(result.status).toBe("success");
    const lines = readFileSync(join(evidence.dir, "log.jsonl"), "utf8");
    expect(lines).toContain("replay.compose");
    expect(VERIFY_AND_FILE_DISPUTE.steps.some((s) => s.action === "navigate")).toBe(false);
  });

  it("blocks a second replay of an irreversible capability even with --approve-risky", async () => {
    const { engine } = harness();
    const ledger = new MemoryRunLedger();
    const inputs = { memberId: "12345", product: "Share Savings" };
    const first = await engine.run(OPEN_SUB_ACCOUNT, { inputs, approveRisky: true, ledger });
    expect(first.status).toBe("success");
    const second = await engine.run(OPEN_SUB_ACCOUNT, { inputs, approveRisky: true, ledger });
    expect(second.status).toBe("failed");
    expect(second.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(second.message).toMatch(/Compensation/);
  });

  it("honors per-step retryBudget instead of a hardcoded engine cap", async () => {
    const { engine } = harness("notice");
    const tight = {
      ...LOOKUP_MEMBER_SAVINGS,
      steps: LOOKUP_MEMBER_SAVINGS.steps.map((step) => ({ ...step, retryBudget: 0 })),
    };
    const result = await engine.run(tight, { inputs: { memberId: "12345" } });
    expect(result.status).toBe("needs_human");
    expect(result.code).toBe("RECOVERABLE_EXHAUSTED");
  });

  it("flags westside rank-3 fallbacks as needsRediscovery", async () => {
    const surface = new MockSurface("search", WESTSIDE_LABELS);
    const evidence = new EvidenceStore("west", mkdtempSync(join(tmpdir(), "relay-")));
    const engine = new ReplayEngine(surface, evidence);
    const bound = bindTenant(VERIFY_AND_FILE_DISPUTE, "westside-drift");
    const result = await engine.run(bound.capability, {
      inputs: { memberId: "12345", merchant: "ACME POS", last4: "4412", reason: "Unauthorized" },
      approveRisky: true,
    });
    expect(result.status).toBe("success");
    expect(result.needsRediscovery).toBe(true);
    expect(result.confidence ?? 1).toBeLessThan(0.7);
    expect(result.locatorHits?.some((hit) => hit.rank === 3)).toBe(true);
    expect(result.metrics?.modelCalls).toBe(0);
  });
});
