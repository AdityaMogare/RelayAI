import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ControlPlane } from "../src/escalation/control.ts";
import { EvidenceStore } from "../src/evidence/store.ts";
import { MockSurface } from "../src/surfaces/mock.ts";

describe("control plane", () => {
  it("pauses the same surface and restores automation on resume", async () => {
    const surface = new MockSurface();
    const evidence = new EvidenceStore("esc", mkdtempSync(join(tmpdir(), "relay-")));
    const plane = new ControlPlane(surface, evidence, async (req) => {
      expect(surface.whoHasControl()).toBe("human");
      expect(req.reason).toContain("stuck");
      return { action: "resume", note: "operator finished" };
    });
    expect(surface.whoHasControl()).toBe("automation");
    const decision = await plane.escalate({ reason: "agent stuck", goal: "lookup" });
    expect(decision.action).toBe("resume");
    expect(surface.whoHasControl()).toBe("automation");
    expect(plane.lastIntervention?.goal).toBe("lookup");
  });

  it("leaves the session with the human when they abort", async () => {
    const surface = new MockSurface();
    const evidence = new EvidenceStore("esc2", mkdtempSync(join(tmpdir(), "relay-")));
    const plane = new ControlPlane(surface, evidence, async () => ({ action: "abort", note: "stop" }));
    await plane.escalate({ reason: "unsafe" });
    expect(surface.whoHasControl()).toBe("human");
  });
});
