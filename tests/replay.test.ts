import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LOOKUP_MEMBER_SAVINGS, OPEN_SUB_ACCOUNT, VERIFY_AND_FILE_DISPUTE } from "../src/artifact/compile.ts";
import { ControlPlane, immediateAbort, immediateResume } from "../src/escalation/control.ts";
import { EvidenceStore } from "../src/evidence/store.ts";
import { ReplayEngine } from "../src/replay/engine.ts";
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
    expect(result.outputs?.savingsBalance).toBe("$4,250.00");
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
    expect(result.outputs?.savingsBalance).toBe("$4,250.00");
  });

  it("stops on session expiry as a hard failure", async () => {
    const { engine } = harness();
    const result = await engine.run(LOOKUP_MEMBER_SAVINGS, { inputs: { memberId: "00000" } });
    expect(result.status).toBe("failed");
    expect(result.code).toBe("SESSION_EXPIRED");
  });

  it("reports a locator miss as a debuggable hard failure", async () => {
    const { engine, surface } = harness();
    surface.failNextLocator = true;
    const result = await engine.run(LOOKUP_MEMBER_SAVINGS, { inputs: { memberId: "12345" } });
    expect(result.status).toBe("failed");
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
      inputs: { memberId: "12345", disputeId: "DSP-1001", reason: "Unauthorized" },
      approveRisky: true,
    });
    expect(result.status).toBe("success");
    expect(result.outputs?.transactionAmount).toBe("$42.18");
    expect(result.outputs?.confirmation).toContain("CASE-77201");
  });

  it("classifies a missing dispute as a business outcome", async () => {
    const { engine } = harness();
    const result = await engine.run(VERIFY_AND_FILE_DISPUTE, {
      inputs: { memberId: "12345", disputeId: "DSP-9999", reason: "Unauthorized" },
      approveRisky: true,
    });
    expect(result.status).toBe("business_outcome");
    expect(result.code).toBe("DISPUTE_NOT_FOUND");
  });

  it("classifies an already-filed dispute as a business outcome", async () => {
    const { engine } = harness();
    const result = await engine.run(VERIFY_AND_FILE_DISPUTE, {
      inputs: { memberId: "12345", disputeId: "DSP-1002", reason: "Unauthorized" },
      approveRisky: true,
    });
    expect(result.status).toBe("business_outcome");
    expect(result.code).toBe("DISPUTE_ALREADY_FILED");
  });
});
