import { randomUUID } from "node:crypto";
import type { Surface } from "../core/surface.ts";
import type { InterventionRequest } from "../core/types.ts";
import type { EvidenceStore } from "../evidence/store.ts";

export type ResumeDecision = { action: "resume" | "abort"; note?: string };

export type ResumeWaiter = (req: InterventionRequest) => Promise<ResumeDecision>;

export class ControlPlane {
  lastIntervention?: InterventionRequest;
  lastHumanNote?: string;

  constructor(
    private readonly surface: Surface,
    private readonly evidence: EvidenceStore,
    private readonly waitForResume: ResumeWaiter,
  ) {}

  async escalate(partial: Omit<InterventionRequest, "id" | "createdAt">): Promise<ResumeDecision> {
    const req: InterventionRequest = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      ...partial,
    };
    this.lastIntervention = req;
    this.evidence.saveIntervention(req);
    this.evidence.event("escalation", {
      id: req.id,
      reason: req.reason,
      stepId: req.stepId,
    });
    await this.surface.pause();
    const decision = await this.waitForResume(req);
    this.lastHumanNote = decision.note ?? (decision.action === "resume" ? "operator resumed" : "operator aborted");
    this.evidence.event("human", {
      interventionId: req.id,
      action: decision.action,
      note: this.lastHumanNote,
    });
    if (decision.action === "resume") {
      await this.surface.resume();
    }
    return decision;
  }
}

export function immediateResume(note = "auto-resume"): ResumeWaiter {
  return async () => ({ action: "resume", note });
}

export function immediateAbort(note = "auto-abort"): ResumeWaiter {
  return async () => ({ action: "abort", note });
}
