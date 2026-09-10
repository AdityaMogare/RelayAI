import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ControlPlane, humanCompletesRiskyStep, immediateAbort } from "../src/escalation/control.ts";
import { holderOf, interventionPriority, sortQueue } from "../src/escalation/lifecycle.ts";
import { operatorHtml } from "../src/escalation/operator.ts";
import { EvidenceStore } from "../src/evidence/store.ts";
import { MockSurface } from "../src/surfaces/mock.ts";
import type { InterventionRequest } from "../src/core/types.ts";

function evidence(name: string): EvidenceStore {
  return new EvidenceStore(name, mkdtempSync(join(tmpdir(), "relay-")));
}

describe("control plane", () => {
  it("pauses the same surface and restores automation on resume", async () => {
    const surface = new MockSurface();
    const plane = new ControlPlane(surface, evidence("esc"), async (req, handle) => {
      expect(surface.whoHasControl()).toBe("human");
      expect(req.reason).toContain("stuck");
      handle.claim("teller01");
      handle.takeControl();
      return { action: "resume", operatorId: "teller01", stepDisposition: "not_done", note: "operator finished" };
    });
    expect(surface.whoHasControl()).toBe("automation");
    const decision = await plane.escalate({ reason: "agent stuck", goal: "lookup" });
    expect(decision.action).toBe("resume");
    expect(surface.whoHasControl()).toBe("automation");
    expect(plane.lastIntervention?.goal).toBe("lookup");
    expect(plane.lastIntervention?.state).toBe("returned");
    expect(plane.lastIntervention?.operatorId).toBe("teller01");
    expect(plane.lastIntervention?.transitions?.map((t) => t.state)).toEqual([
      "raised",
      "claimed",
      "in_control",
      "returned",
    ]);
  });

  it("releases the teller session on abort instead of holding it forever", async () => {
    const surface = new MockSurface();
    const plane = new ControlPlane(surface, evidence("esc2"), immediateAbort("stop"));
    await plane.escalate({ reason: "unsafe" });
    expect(surface.whoHasControl()).toBe("automation");
    expect(plane.lastIntervention?.state).toBe("abandoned");
    expect(plane.lastIntervention?.operatorId).toBe("ci-bot");
  });

  it("abandons an unattended waiter when the TTL fires", async () => {
    const surface = new MockSurface();
    const plane = new ControlPlane(surface, evidence("ttl"), () => new Promise(() => {}), { ttlMs: 40 });
    const started = Date.now();
    const decision = await plane.escalate({ reason: "risky confirm", stepId: "s10-confirm" });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(decision.action).toBe("abort");
    expect(decision.code).toBe("INTERVENTION_TTL");
    expect(plane.lastIntervention?.state).toBe("abandoned");
    expect(surface.whoHasControl()).toBe("automation");
  });

  it("refuses a second in_control on the same live session", async () => {
    const surface = new MockSurface();
    let release!: (value: { action: "resume"; stepDisposition: "not_done" }) => void;
    const firstWait = new Promise<{ action: "resume"; stepDisposition: "not_done" }>((resolve) => {
      release = resolve;
    });
    const plane1 = new ControlPlane(surface, evidence("one"), async (_req, handle) => {
      handle.claim("teller01");
      handle.takeControl();
      return firstWait;
    });
    const plane2 = new ControlPlane(surface, evidence("two"), async () => ({
      action: "resume",
      stepDisposition: "not_done",
    }));
    const first = plane1.escalate({ reason: "one", capabilityId: "verify-and-file-dispute" });
    await new Promise((r) => setTimeout(r, 20));
    const second = await plane2.escalate({ reason: "two", capabilityId: "open-sub-account" });
    expect(second.action).toBe("abort");
    expect(plane2.lastIntervention?.state).toBe("abandoned");
    expect(second.note).toMatch(/already in_control/);
    release({ action: "resume", stepDisposition: "not_done" });
    await first;
    expect(plane1.lastIntervention?.operatorId).toBe("teller01");
  });

  it("records url/title/screenshot and an a11y diff for the handoff window", async () => {
    const surface = new MockSurface("confirm");
    const store = evidence("esc3");
    const plane = new ControlPlane(surface, store, async (_req, handle) => {
      handle.claim("teller01");
      handle.takeControl();
      surface.page = "opened";
      return {
        action: "resume",
        operatorId: "teller01",
        stepDisposition: "completed_by_human",
      };
    });
    const decision = await plane.escalate({
      reason: "risky confirm",
      stepId: "s06-confirm",
      url: "http://127.0.0.1:3000/member/12345/sub-account/confirm",
      sessionId: surface.sessionId(),
    });
    expect(decision.stepCompletedByHuman).toBe(true);
    expect(decision.stepDisposition).toBe("completed_by_human");
    expect(existsSync(join(store.dir, "handoff-before.png"))).toBe(true);
    expect(existsSync(join(store.dir, "handoff-after.png"))).toBe(true);
    const before = JSON.parse(readFileSync(join(store.dir, "handoff-before.json"), "utf8")) as {
      url: string;
      title: string;
      sessionId: string;
    };
    const after = JSON.parse(readFileSync(join(store.dir, "handoff-after.json"), "utf8")) as {
      title: string;
      ariaDiff: { added: string[]; removed: string[] };
      stepDisposition: string;
      operatorId: string;
      audit: string;
    };
    expect(before.sessionId).toBe(surface.sessionId());
    expect(before.title).toContain("Confirm sub-account");
    expect(after.title).toContain("Sub-account opened");
    expect(after.ariaDiff.added.some((line) => line.includes("Confirmation"))).toBe(true);
    expect(after.stepDisposition).toBe("completed_by_human");
    expect(after.operatorId).toBe("teller01");
    expect(after.audit).toMatch(/operator teller01 took control at /);
    const lines = readFileSync(join(store.dir, "log.jsonl"), "utf8");
    expect(lines).toContain("human.handoff");
    expect(lines).toContain("intervention.transition");
    expect(lines).not.toContain("operator resumed");
  });

  it("asks for an explicit step disposition after claim", () => {
    const html = operatorHtml({
      id: "i1",
      createdAt: "2026-09-10T00:00:00.000Z",
      reason: "risky",
      stepId: "s10-confirm",
      sessionId: "ses_live",
      url: "http://127.0.0.1:3000/member/12345/disputes/DSP-1001/file?step=review",
      state: "in_control",
      operatorId: "teller01",
      checkpointExpect: 'textIncludes "Dispute filed"',
      claimedAt: "2026-09-10T14:02:11.000Z",
      inControlAt: "2026-09-10T14:02:11.000Z",
    });
    expect(html).toContain('name="disposition"');
    expect(html).toContain("completed_by_human");
    expect(html).toContain("not_done");
    expect(html).toContain("Did you complete this step?");
    expect(html).toContain("ses_live");
    expect(html).toContain("headed Chromium window");
    expect(html).toContain("Dispute filed");
    expect(html).toContain("teller01 took control at");
  });

  it("requires operator identity to claim a raised intervention", () => {
    const html = operatorHtml({
      id: "i2",
      createdAt: "2026-09-10T00:00:00.000Z",
      reason: "risky",
      state: "raised",
      sessionId: "ses_live",
    });
    expect(html).toContain("Claim this session");
    expect(html).toContain('name="operatorId"');
  });
});

describe("operator queue routing", () => {
  it("ranks dispute filing ahead of sub-account opening", () => {
    expect(interventionPriority("verify-and-file-dispute")).toBeLessThan(
      interventionPriority("open-sub-account"),
    );
    const queued: InterventionRequest[] = [
      { id: "b", createdAt: "2026-09-10T00:00:02.000Z", reason: "x", capabilityId: "open-sub-account" },
      { id: "a", createdAt: "2026-09-10T00:00:01.000Z", reason: "x", capabilityId: "verify-and-file-dispute" },
    ];
    expect(sortQueue(queued).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("treats claimed and in_control as exclusive holders", () => {
    const records: InterventionRequest[] = [
      { id: "raised", createdAt: "", reason: "", state: "raised", capabilityId: "open-sub-account" },
      {
        id: "held",
        createdAt: "",
        reason: "",
        state: "in_control",
        operatorId: "teller01",
        capabilityId: "verify-and-file-dispute",
      },
    ];
    expect(holderOf(records)?.id).toBe("held");
  });
});

describe("humanCompletesRiskyStep", () => {
  it("acts on the paused session rather than a note string", async () => {
    const surface = new MockSurface("disputeReview");
    const plane = new ControlPlane(
      surface,
      evidence("human-act"),
      humanCompletesRiskyStep("teller01", async () => {
        const result = await surface.actAsHuman({
          name: "click",
          target: { primary: { by: "role", role: "button", name: "Confirm" } },
        });
        expect(result.ok).toBe(true);
      }),
    );
    await plane.escalate({ reason: "risky", stepId: "s10-confirm" });
    expect(surface.page).toBe("disputeFiled");
    expect(plane.lastDecision?.stepDisposition).toBe("completed_by_human");
    expect(plane.lastIntervention?.operatorId).toBe("teller01");
    expect(plane.lastIntervention?.operatorKind).toBe("scripted");
    expect(plane.lastDecision?.operatorKind).toBe("scripted");
  });
});
