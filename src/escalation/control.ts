import { randomUUID } from "node:crypto";
import { RelayError } from "../core/errors.ts";
import type { Surface } from "../core/surface.ts";
import type { InterventionRequest, Observation, StepDisposition } from "../core/types.ts";
import { ariaSnapshotDiff } from "../evidence/aria-diff.ts";
import type { EvidenceStore } from "../evidence/store.ts";
import {
  auditLine,
  createIntervention,
  defaultTtlMs,
  transition,
} from "./lifecycle.ts";

export type ResumeDecision = {
  action: "resume" | "abort";
  note?: string;
  operatorId?: string;
  stepDisposition?: StepDisposition;
  /** Derived from stepDisposition; kept so older tests still read it. */
  stepCompletedByHuman?: boolean;
  /** Typed abort reason — do not parse `note`. */
  code?: "INTERVENTION_TTL" | "SESSION_HELD" | "ABORTED";
  operatorKind?: InterventionRequest["operatorKind"];
};

export type InterventionHandle = {
  claim(operatorId: string, opts?: { operatorKind?: InterventionRequest["operatorKind"] }): InterventionRequest;
  takeControl(): InterventionRequest;
  record(): InterventionRequest;
  signal: AbortSignal;
};

export type ResumeWaiter = (
  req: InterventionRequest,
  handle: InterventionHandle,
) => Promise<ResumeDecision>;

export type HandoffCapture = {
  before: { url: string; title: string; screenshotPath: string };
  after: { url: string; title: string; screenshotPath: string };
  ariaDiff: { added: string[]; removed: string[] };
};

/** One live Playwright session can be in_control of at most one intervention. */
const surfaceHeld = new WeakMap<Surface, string>();

export class ControlPlane {
  lastIntervention?: InterventionRequest;
  lastHumanNote?: string;
  lastDecision?: ResumeDecision;
  lastHandoff?: HandoffCapture;
  private readonly ttlMs: number;

  constructor(
    private readonly surface: Surface,
    private readonly evidence: EvidenceStore,
    private readonly waitForResume: ResumeWaiter,
    opts?: { ttlMs?: number },
  ) {
    this.ttlMs = opts?.ttlMs ?? defaultTtlMs();
  }

  async escalate(partial: Omit<InterventionRequest, "id" | "createdAt">): Promise<ResumeDecision> {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    let req = createIntervention(
      {
        ...partial,
        id,
        createdAt,
        sessionId: partial.sessionId ?? this.surface.sessionId(),
      },
      this.ttlMs,
    );
    this.persist(req);

    const held = surfaceHeld.get(this.surface);
    if (held && held !== id) {
      req = transition(req, "abandoned", {
        note: `session ${req.sessionId} already in_control of intervention ${held}`,
      });
      this.persist(req);
      const blocked: ResumeDecision = {
        action: "abort",
        stepDisposition: "abort",
        code: "SESSION_HELD",
        note: req.transitions?.at(-1)?.note,
      };
      this.lastDecision = blocked;
      this.lastHumanNote = blocked.note;
      return blocked;
    }
    surfaceHeld.set(this.surface, id);

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.ttlMs);
    const handle = this.makeHandle(abort.signal);

    this.evidence.event("escalation", {
      id: req.id,
      reason: req.reason,
      stepId: req.stepId,
      sessionId: req.sessionId,
      state: req.state,
      ttlMs: req.ttlMs,
      expiresAt: req.expiresAt,
    });

    try {
      const before = await this.captureSide("handoff-before");
      await this.surface.pause();

      const decision = normalizeDecision(await this.raceWaiter(handle, abort.signal));
      this.lastDecision = decision;
      this.lastHumanNote = decision.note;
      this.applyDecision(decision, abort.signal.aborted);

      const after = await this.captureSide("handoff-after");
      const ariaDiff = ariaSnapshotDiff(before.aria, after.aria);
      this.lastHandoff = {
        before: { url: before.url, title: before.title, screenshotPath: before.screenshotPath },
        after: { url: after.url, title: after.title, screenshotPath: after.screenshotPath },
        ariaDiff,
      };
      const current = this.requireRecord();
      this.evidence.saveJson("handoff-before.json", {
        url: before.url,
        title: before.title,
        screenshotPath: before.screenshotPath,
        sessionId: current.sessionId,
      });
      this.evidence.saveJson("handoff-after.json", {
        url: after.url,
        title: after.title,
        screenshotPath: after.screenshotPath,
        ariaDiff,
        sessionId: current.sessionId,
        stepDisposition: current.stepDisposition,
        stepCompletedByHuman: Boolean(decision.stepCompletedByHuman),
        operatorId: current.operatorId,
        audit: auditLine(current),
      });
      this.evidence.event("human", {
        interventionId: current.id,
        action: decision.action,
        note: decision.note,
        operatorId: current.operatorId,
        stepDisposition: current.stepDisposition,
        stepCompletedByHuman: Boolean(decision.stepCompletedByHuman),
        audit: auditLine(current),
      });
      this.evidence.event("human.handoff", {
        interventionId: current.id,
        sessionId: current.sessionId,
        operatorId: current.operatorId,
        stepDisposition: current.stepDisposition,
        before: { url: before.url, title: before.title, screenshotPath: before.screenshotPath },
        after: { url: after.url, title: after.title, screenshotPath: after.screenshotPath },
        ariaDiff,
        audit: auditLine(current),
      });

      if (decision.action === "resume") {
        await this.surface.resume();
      } else {
        await this.releaseSession();
      }
      return decision;
    } finally {
      clearTimeout(timer);
      if (!abort.signal.aborted) abort.abort();
      if (surfaceHeld.get(this.surface) === id) surfaceHeld.delete(this.surface);
    }
  }

  finish(outcome: "resolved" | "abandoned", note?: string): InterventionRequest {
    const current = this.requireRecord();
    if (current.state === "resolved" || current.state === "abandoned") return current;
    const next = transition(current, outcome, { operatorId: current.operatorId, note });
    this.persist(next);
    return next;
  }

  private makeHandle(signal: AbortSignal): InterventionHandle {
    return {
      claim: (operatorId: string, opts?: { operatorKind?: InterventionRequest["operatorKind"] }) => {
        const current = this.requireRecord();
        if (current.state !== "raised") return current;
        const next = {
          ...transition(current, "claimed", { operatorId, note: `${operatorId} claimed` }),
          operatorKind: opts?.operatorKind ?? current.operatorKind,
        };
        this.persist(next);
        return next;
      },
      takeControl: () => {
        let current = this.requireRecord();
        if (current.state === "raised") {
          current = transition(current, "claimed", {
            operatorId: current.operatorId ?? "unknown",
            note: "claimed on take-control",
          });
          this.persist(current);
        }
        if (current.state !== "claimed") return current;
        const next = transition(current, "in_control", {
          operatorId: current.operatorId,
          note: `${current.operatorId} in_control`,
        });
        this.persist(next);
        return next;
      },
      record: () => this.requireRecord(),
      signal,
    };
  }

  private async raceWaiter(
    handle: InterventionHandle,
    signal: AbortSignal,
  ): Promise<ResumeDecision> {
    const ttl: ResumeDecision = {
      action: "abort",
      stepDisposition: "abort",
      code: "INTERVENTION_TTL",
      note: "intervention TTL expired; session released without executing the risky step",
    };
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (decision: ResumeDecision) => {
        if (settled) return;
        settled = true;
        resolve(decision);
      };
      const onAbort = () => finish(ttl);
      if (signal.aborted) {
        finish(ttl);
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      void this.waitForResume(this.requireRecord(), handle).then(
        (decision) => {
          signal.removeEventListener("abort", onAbort);
          finish(decision);
        },
        (err) => {
          signal.removeEventListener("abort", onAbort);
          if (!settled) {
            settled = true;
            reject(err);
          }
        },
      );
    });
  }

  private applyDecision(decision: ResumeDecision, timedOut: boolean): void {
    let current = this.requireRecord();
    const operatorId = decision.operatorId ?? current.operatorId;
    if (decision.operatorKind) {
      current = { ...current, operatorKind: decision.operatorKind };
      this.lastIntervention = current;
    }
    if (timedOut || decision.action === "abort" || decision.stepDisposition === "abort") {
      current = transition(current, "abandoned", {
        operatorId,
        note: decision.note,
        stepDisposition: "abort",
      });
      this.persist(current);
      return;
    }
    if (current.state === "raised") {
      current = transition(current, "claimed", { operatorId: operatorId ?? "unknown", note: decision.note });
      this.persist(current);
    }
    if (current.state === "claimed") {
      current = transition(current, "in_control", { operatorId: current.operatorId });
      this.persist(current);
    }
    if (current.state === "in_control") {
      current = transition(current, "returned", {
        operatorId: current.operatorId,
        note: decision.note,
        stepDisposition: decision.stepDisposition,
      });
      this.persist(current);
    }
  }

  private async releaseSession(): Promise<void> {
    if (this.surface.whoHasControl() === "human") {
      await this.surface.resume();
    }
    await this.surface.act({ name: "navigate", url: "about:blank" }).catch(() => undefined);
  }

  private persist(record: InterventionRequest): void {
    this.lastIntervention = record;
    this.evidence.saveIntervention(record);
    this.evidence.event("intervention.transition", {
      id: record.id,
      state: record.state,
      operatorId: record.operatorId,
      operatorKind: record.operatorKind,
      stepDisposition: record.stepDisposition,
      audit: auditLine(record),
      claimedAt: record.claimedAt,
      inControlAt: record.inControlAt,
      returnedAt: record.returnedAt,
      abandonedAt: record.abandonedAt,
      resolvedAt: record.resolvedAt,
    });
  }

  private requireRecord(): InterventionRequest {
    if (!this.lastIntervention) throw new RelayError("NO_INTERVENTION", "No intervention on this control plane.");
    return this.lastIntervention;
  }

  private async captureSide(name: "handoff-before" | "handoff-after"): Promise<{
    url: string;
    title: string;
    aria: string;
    screenshotPath: string;
  }> {
    const observed: Observation = await this.surface.observe();
    const shot = await this.surface.screenshot().catch(() => Buffer.from(""));
    const screenshotPath = await this.evidence.saveScreenshot(`${name}.png`, shot);
    return { url: observed.url, title: observed.title, aria: observed.aria, screenshotPath };
  }
}

export function normalizeDecision(decision: ResumeDecision): ResumeDecision {
  if (decision.action === "abort" || decision.stepDisposition === "abort") {
    return { ...decision, action: "abort", stepDisposition: "abort", stepCompletedByHuman: false };
  }
  const completed =
    decision.stepDisposition === "completed_by_human" || decision.stepCompletedByHuman === true;
  return {
    ...decision,
    action: "resume",
    stepDisposition: completed ? "completed_by_human" : "not_done",
    stepCompletedByHuman: completed,
  };
}

export function immediateResume(note = "auto-resume"): ResumeWaiter {
  return async (_req, handle) => {
    handle.claim("ci-bot", { operatorKind: "scripted" });
    handle.takeControl();
    return {
      action: "resume",
      note,
      operatorId: "ci-bot",
      stepDisposition: "not_done",
      operatorKind: "scripted",
    };
  };
}

export function immediateAbort(note = "auto-abort"): ResumeWaiter {
  return async (_req, handle) => {
    handle.claim("ci-bot", { operatorKind: "scripted" });
    handle.takeControl();
    return {
      action: "abort",
      note,
      operatorId: "ci-bot",
      stepDisposition: "abort",
      code: "ABORTED",
      operatorKind: "scripted",
    };
  };
}

/** Evidence / tests: operator does the risky click on the paused session, then hands back skip. */
export function humanCompletesRiskyStep(operatorId: string, act: () => Promise<void>): ResumeWaiter {
  return async (_req, handle) => {
    handle.claim(operatorId, { operatorKind: "scripted" });
    handle.takeControl();
    await act();
    return {
      action: "resume",
      operatorId,
      stepDisposition: "completed_by_human",
      operatorKind: "scripted",
      note: `${operatorId} completed the risky step on the live session`,
    };
  };
}
