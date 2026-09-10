import type { Surface } from "../core/surface.ts";
import { locatorLabel } from "../core/surface.ts";
import type {
  ArtifactStep,
  Capability,
  Checkpoint,
  ExceptionalState,
  LocatorHit,
  Observation,
  OutputValue,
  RunResult,
} from "../core/types.ts";
import type { ControlPlane, ResumeDecision } from "../escalation/control.ts";
import { summarizePublic } from "../evidence/observe.ts";
import type { EvidenceStore } from "../evidence/store.ts";
import type { ExceptionDisposition } from "./classifier.ts";
import type { ReplayOptions } from "./options.ts";

export type HandoffHost = {
  surface: Surface;
  evidence: EvidenceStore;
  matchException: (capability: Capability, observed: Observation) => ExceptionalState | undefined;
  handleException: (
    state: ExceptionalState,
    observed: Observation,
    stepId: string,
    outputs: Record<string, OutputValue>,
    hits: LocatorHit[],
  ) => Promise<ExceptionDisposition>;
  checkpointHolds: (checkpoint: Checkpoint, observed: Observation) => boolean;
  describeCheckpoint: (checkpoint: Checkpoint) => string;
  complete: (partial: Omit<RunResult, "outputs" | "evidencePath">, outputs: Record<string, OutputValue>, hits: LocatorHit[]) => RunResult;
  fail: (opts: {
    stepId: string;
    expected: string;
    observedText: string;
    observation: Observation | undefined;
    outputs: Record<string, OutputValue>;
    hits: LocatorHit[];
    code: string;
    classify: RunResult["classify"];
    status?: "failed" | "needs_human";
    message?: string;
  }) => Promise<RunResult>;
};

export async function afterRiskyHandback(
  host: HandoffHost,
  options: ReplayOptions,
  step: ArtifactStep,
  observed: Observation,
  capability: Capability,
  outputs: Record<string, OutputValue>,
  hits: LocatorHit[],
): Promise<{ kind: "stop"; result: RunResult } | { kind: "skip" } | { kind: "execute" }> {
  const reason = "Risky/irreversible step requires human approval.";
  if (!options.control) {
    return {
      kind: "stop",
      result: host.complete(
        {
          status: "escalated",
          code: "RISKY_ACTION_BLOCKED",
          message: reason,
          stepId: step.id,
        },
        outputs,
        hits,
      ),
    };
  }
  const decision = await escalateToHuman(host, options.control, step, observed, capability, reason);
  if (decision.action === "abort") {
    options.control.finish("abandoned", decision.note);
    return {
      kind: "stop",
      result: host.complete(
        {
          status: "escalated",
          interventionId: options.control.lastIntervention?.id,
          message: decision.note ?? reason,
          stepId: step.id,
          code: decision.code ?? (decision.action === "abort" ? "ABORTED" : undefined),
        },
        outputs,
        hits,
      ),
    };
  }

  const after = await host.surface.observe();
  const exceptional = host.matchException(capability, after);
  if (exceptional) {
    const handled = await host.handleException(exceptional, after, step.id, outputs, hits);
    if (handled.kind === "stop") {
      options.control.finish("abandoned", exceptional.code);
      return { kind: "stop", result: handled.result };
    }
  }

  const checkpointHeld = step.checkpoint ? host.checkpointHolds(step.checkpoint, after) : false;
  const disposition =
    decision.stepDisposition ?? (decision.stepCompletedByHuman ? "completed_by_human" : "not_done");
  const entry = options.control.lastIntervention?.entryCheckpoint;
  const entryHeld = entry ? host.checkpointHolds(entry, after) : true;
  const skip = checkpointHeld || disposition === "completed_by_human";

  host.evidence.event("replay.reconcile", {
    stepId: step.id,
    skip,
    checkpointHeld,
    entryHeld,
    entryCheckpoint: entry,
    stepDisposition: disposition,
    stepCompletedByHuman: disposition === "completed_by_human",
    operatorId: decision.operatorId ?? options.control.lastIntervention?.operatorId,
    operatorKind: options.control.lastIntervention?.operatorKind ?? decision.operatorKind,
    claimedAt: options.control.lastIntervention?.claimedAt,
    returnedAt: options.control.lastIntervention?.returnedAt,
  });

  if (skip) {
    options.control.finish("resolved", "risky step skipped after human handback");
    return { kind: "skip" };
  }

  if (!entryHeld) {
    options.control.finish("abandoned", "entry checkpoint lost after resume");
    return {
      kind: "stop",
      result: await host.fail({
        stepId: step.id,
        expected: entry ? host.describeCheckpoint(entry) : "entry checkpoint",
        observedText: summarizePublic(after),
        observation: after,
        outputs,
        hits,
        code: "PRECONDITION_LOST",
        classify: "hard_failure",
        status: "needs_human",
        message: `After resume, entry checkpoint no longer held — the operator left the step's page. Risky action was not executed.`,
      }),
    };
  }

  options.control.finish("resolved", "risky step will execute once");
  return { kind: "execute" };
}

export async function escalateToHuman(
  host: Pick<HandoffHost, "surface" | "evidence" | "describeCheckpoint">,
  control: ControlPlane,
  step: ArtifactStep,
  observed: Observation,
  capability: Capability,
  reason: string,
): Promise<ResumeDecision> {
  const shot = await host.surface.screenshot().catch(() => Buffer.from(""));
  const screenshotPath = await host.evidence.saveScreenshot(`escalate-${step.id}.png`, shot);
  return control.escalate({
    reason,
    capabilityId: capability.id,
    stepId: step.id,
    url: observed.url,
    screenshotPath,
    observationPreview: summarizePublic(observed),
    checkpointExpect: step.checkpoint ? host.describeCheckpoint(step.checkpoint) : undefined,
    sessionId: host.surface.sessionId(),
    entryCheckpoint: {
      kind: "urlIncludes",
      expect: pathnameOf(observed.url),
    },
  });
}

export function dryRunWouldExecute(capability: Capability, stoppedAt: ArtifactStep) {
  const remaining = capability.steps.slice(capability.steps.indexOf(stoppedAt));
  return remaining.map((step) => ({
    stepId: step.id,
    action: step.action,
    risk: step.risk,
    target: step.target?.primary,
    note: step.note ?? (step.target ? locatorLabel(step.target.primary) : step.action),
  }));
}

function pathnameOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
