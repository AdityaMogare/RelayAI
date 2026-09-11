import type { Surface } from "../core/surface.ts";
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
import type { ControlPlane } from "../escalation/control.ts";
import { summarizePublic } from "../evidence/observe.ts";
import type { EvidenceStore } from "../evidence/store.ts";

export type ExceptionDisposition =
  | { kind: "stop"; result: RunResult }
  | { kind: "retry_observe" }
  | { kind: "retry_action" }
  | { kind: "reauth" };

export function matchesDetect(state: ExceptionalState, observed: Observation): boolean {
  const { detect } = state;
  if (detect.locatorMiss) return false;
  if (detect.textIncludes) {
    const blob = `${observed.text}\n${observed.aria}`;
    if (!blob.includes(detect.textIncludes)) return false;
  }
  if (detect.dialogTitle && observed.dialog !== detect.dialogTitle) return false;
  if (detect.urlIncludes && !observed.url.includes(detect.urlIncludes)) return false;
  return Boolean(detect.textIncludes || detect.dialogTitle || detect.urlIncludes);
}

export function matchException(capability: Capability, observed: Observation): ExceptionalState | undefined {
  return capability.exceptionalStates.find((state) => matchesDetect(state, observed));
}

export function matchLocatorMiss(capability: Capability, observed: Observation): ExceptionalState | undefined {
  return capability.exceptionalStates.find((state) => {
    if (!state.detect.locatorMiss) return false;
    if (!state.detect.urlIncludes) return true;
    try {
      const path = new URL(observed.url).pathname;
      if (state.detect.urlIncludes === "/disputes") return /\/disputes\/?$/.test(path);
    } catch {
      /* fall through */
    }
    return observed.url.includes(state.detect.urlIncludes);
  });
}

export function matchAnti(
  capability: Capability,
  step: ArtifactStep | undefined,
  observed: Observation,
  holds: (checkpoint: Checkpoint, observed: Observation) => boolean,
): Checkpoint | undefined {
  const checks = [...(capability.antiCheckpoints ?? []), ...(step?.antiCheckpoints ?? [])];
  return checks.find((check) => holds(check, observed));
}

export type ExceptionHost = {
  surface: Surface;
  evidence: EvidenceStore;
  activeControl?: ControlPlane;
  currentCapability?: Capability;
  currentAudit?: { capabilityId: string };
  escalateToHuman: ControlPlane["escalate"] extends never
    ? never
    : (
        control: ControlPlane,
        step: ArtifactStep,
        observed: Observation,
        capability: Capability,
        reason: string,
      ) => Promise<import("../escalation/control.ts").ResumeDecision>;
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

export async function handleException(
  host: ExceptionHost,
  state: ExceptionalState,
  observed: Observation,
  stepId: string,
  outputs: Record<string, OutputValue>,
  hits: LocatorHit[],
): Promise<ExceptionDisposition> {
  host.evidence.event("replay.exception", {
    code: state.code,
    classify: state.classify,
    stepId,
  });
  if (state.classify === "business_outcome") {
    return {
      kind: "stop",
      result: host.complete(
        {
          status: "business_outcome",
          classify: "business_outcome",
          code: state.code,
          message: state.message,
          stepId,
          observed: summarizePublic(observed),
        },
        outputs,
        hits,
      ),
    };
  }
  if (state.classify === "needs_human") {
    const control = host.activeControl;
    if (control && state.code === "SESSION_EXPIRED") {
      const decision = await host.escalateToHuman(
        control,
        { id: stepId, action: "wait", risk: "safe", timeoutMs: 8000, retryBudget: 3 },
        observed,
        host.currentCapability ?? ({ id: host.currentAudit?.capabilityId ?? "unknown" } as Capability),
        state.message,
      );
      if (decision.action === "abort") {
        control.finish("abandoned", decision.note);
        return {
          kind: "stop",
          result: host.complete(
            {
              status: "escalated",
              interventionId: control.lastIntervention?.id,
              message: decision.note ?? state.message,
              stepId,
              code: decision.code ?? "ABORTED",
            },
            outputs,
            hits,
          ),
        };
      }
      host.evidence.event("replay.session.resume", {
        stepId,
        operatorId: decision.operatorId,
        code: state.code,
      });
      control.finish("resolved", "session restored by operator");
      return { kind: "reauth" };
    }
    if (control) {
      const decision = await host.escalateToHuman(
        control,
        { id: stepId, action: "wait", risk: "safe", timeoutMs: 8000, retryBudget: 3 },
        observed,
        host.currentCapability ?? ({ id: host.currentAudit?.capabilityId ?? "unknown" } as Capability),
        state.message,
      );
      control.finish(decision.action === "abort" ? "abandoned" : "resolved", decision.note ?? state.message);
      return {
        kind: "stop",
        result: host.complete(
          {
            status: "escalated",
            interventionId: control.lastIntervention?.id,
            message: decision.note ?? state.message,
            stepId,
            code: state.code,
          },
          outputs,
          hits,
        ),
      };
    }
    return {
      kind: "stop",
      result: await host.fail({
        stepId,
        expected: state.message,
        observedText: summarizePublic(observed),
        observation: observed,
        outputs,
        hits,
        code: state.code,
        classify: "needs_human",
        status: "needs_human",
        message: state.message,
      }),
    };
  }
  if (state.classify === "hard_failure") {
    return {
      kind: "stop",
      result: await host.fail({
        stepId,
        expected: state.message,
        observedText: summarizePublic(observed),
        observation: observed,
        outputs,
        hits,
        code: state.code,
        classify: "hard_failure",
      }),
    };
  }
  if (state.classify === "transient") {
    if (state.recoverAction?.action === "wait") {
      await host.surface.act({ name: "wait", value: String(state.recoverAction.ms ?? 200) });
    }
    return { kind: "retry_action" };
  }
  if (state.recoverAction?.action === "dismiss") {
    await host.surface.act({
      name: "dismiss",
      target: state.recoverAction.target,
    });
    return { kind: "retry_observe" };
  }
  if (state.recoverAction?.action === "wait") {
    await host.surface.act({ name: "wait", value: String(state.recoverAction.ms ?? 500) });
    return { kind: "retry_observe" };
  }
  return { kind: "retry_observe" };
}
