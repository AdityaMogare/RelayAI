import type { Surface } from "../core/surface.ts";
import { locatorLabel } from "../core/surface.ts";
import type {
  Action,
  ArtifactStep,
  Capability,
  Checkpoint,
  ExceptionalState,
  Observation,
  RunResult,
} from "../core/types.ts";
import type { ControlPlane } from "../escalation/control.ts";
import type { EvidenceStore } from "../evidence/store.ts";
import { PolicyGuard, PolicyViolation } from "../policy/policy.ts";

export type ReplayOptions = {
  inputs: Record<string, string>;
  approveRisky?: boolean;
  baseUrl?: string;
  control?: ControlPlane;
};

export class ReplayEngine {
  constructor(
    private readonly surface: Surface,
    private readonly evidence: EvidenceStore,
    private readonly policy = new PolicyGuard(),
  ) {}

  async run(capability: Capability, options: ReplayOptions): Promise<RunResult> {
    this.evidence.event("replay.start", {
      capabilityId: capability.id,
      version: capability.version,
      inputs: options.inputs,
    });
    const outputs: Record<string, string> = {};

    try {
      for (const step of capability.steps) {
        let approvedThisStep = Boolean(options.approveRisky);
        let attempts = 0;
        let observed = await this.surface.observe();

        while (true) {
          attempts += 1;
          observed = await this.surface.observe();
          const exceptional = this.matchException(capability, observed);
          if (!exceptional) break;
          const handled = await this.handleException(exceptional, observed, step.id, outputs);
          if (handled) return handled;
          if (attempts > 3) {
            return this.fail(step.id, "recoverable loop", "exceeded recoveries", observed);
          }
        }

        if (step.risk === "risky" && !approvedThisStep) {
          const escalated = await this.escalate(
            options,
            step,
            observed,
            capability,
            "Risky/irreversible step requires human approval.",
          );
          if (escalated) return escalated;
          approvedThisStep = true;
        }

        const action = this.materialize(step, options);
        try {
          this.policy.assertAction(action, observed.url);
        } catch (err) {
          if (err instanceof PolicyViolation) {
            return this.fail(step.id, "policy allowlist", err.message, observed);
          }
          throw err;
        }

        this.evidence.event("replay.step", {
          stepId: step.id,
          action: action.name,
          target: action.target?.primary,
          value: step.inputFrom ? `[param ${step.inputFrom}]` : undefined,
        });

        const result = await this.surface.act(action);
        if (!result.ok) {
          const after = await this.surface.observe();
          const again = this.matchException(capability, after);
          if (again) {
            const handled = await this.handleException(again, after, step.id, outputs);
            if (handled) return handled;
          }
          return this.fail(
            step.id,
            `locator ${action.target ? locatorLabel(action.target.primary) : action.name}`,
            result.error ?? "action failed",
            after,
          );
        }
        if (result.extracted && step.outputName) {
          outputs[step.outputName] = result.extracted;
        }
        if (step.checkpoint) {
          const after = await this.surface.observe();
          if (!this.checkpointHolds(step.checkpoint, after)) {
            const again = this.matchException(capability, after);
            if (again) {
              const handled = await this.handleException(again, after, step.id, outputs);
              if (handled) return handled;
            }
            return this.fail(step.id, this.describeCheckpoint(step.checkpoint), summarize(after), after);
          }
        }
      }

      const finalObs = await this.surface.observe();
      const finalEx = this.matchException(capability, finalObs);
      if (finalEx) {
        const handled = await this.handleException(finalEx, finalObs, "success", outputs);
        if (handled) return handled;
      }
      if (!this.checkpointHolds(capability.success.checkpoint, finalObs)) {
        return this.fail(
          "success",
          this.describeCheckpoint(capability.success.checkpoint),
          summarize(finalObs),
          finalObs,
        );
      }

      for (const output of capability.outputs) {
        if (outputs[output.name]) continue;
        const extracted = await this.surface.act({
          name: "extract",
          target: output.locator,
        });
        if (extracted.extracted) outputs[output.name] = extracted.extracted;
      }

      const result: RunResult = {
        status: "success",
        outputs,
        message: "Capability completed and success checkpoint held.",
        evidencePath: this.evidence.dir,
      };
      this.evidence.saveResult(result);
      this.evidence.event("replay.end", { status: "success", outputs });
      return result;
    } catch (err) {
      const observed = await this.surface.observe().catch(() => undefined);
      return this.fail(
        "uncaught",
        "run completed without error",
        err instanceof Error ? err.message : String(err),
        observed,
      );
    }
  }

  private materialize(step: ArtifactStep, options: ReplayOptions): Action {
    let value = step.value;
    if (step.inputFrom?.startsWith("parameters.")) {
      const key = step.inputFrom.slice("parameters.".length);
      value = options.inputs[key];
      if (value === undefined) {
        throw new Error(`Missing parameter ${key}`);
      }
    }
    return {
      name: step.action,
      target: step.target,
      value,
      url: step.url ? rewriteBase(step.url, options.baseUrl) : undefined,
      outputName: step.outputName,
    };
  }

  private matchException(capability: Capability, observed: Observation): ExceptionalState | undefined {
    return capability.exceptionalStates.find((state) => matchesDetect(state, observed));
  }

  private async handleException(
    state: ExceptionalState,
    observed: Observation,
    stepId: string,
    outputs: Record<string, string>,
  ): Promise<RunResult | undefined> {
    this.evidence.event("replay.exception", {
      code: state.code,
      classify: state.classify,
      stepId,
    });
    if (state.classify === "business_outcome") {
      const result: RunResult = {
        status: "business_outcome",
        code: state.code,
        message: state.message,
        stepId,
        observed: summarize(observed),
        outputs,
        evidencePath: this.evidence.dir,
      };
      this.evidence.saveResult(result);
      return result;
    }
    if (state.classify === "hard_failure") {
      return this.fail(stepId, state.message, summarize(observed), observed, state.code);
    }
    if (state.recoverAction?.action === "dismiss") {
      await this.surface.act({
        name: "dismiss",
        target: state.recoverAction.target,
      });
      return undefined;
    }
    if (state.recoverAction?.action === "wait") {
      await this.surface.act({ name: "wait", value: String(state.recoverAction.ms ?? 500) });
      return undefined;
    }
    return undefined;
  }

  private async escalate(
    options: ReplayOptions,
    step: ArtifactStep,
    observed: Observation,
    capability: Capability,
    reason: string,
  ): Promise<RunResult | undefined> {
    if (!options.control) {
      return {
        status: "escalated",
        code: "RISKY_ACTION_BLOCKED",
        message: reason,
        stepId: step.id,
        evidencePath: this.evidence.dir,
      };
    }
    const shot = await this.surface.screenshot().catch(() => Buffer.from(""));
    const screenshotPath = await this.evidence.saveScreenshot(`escalate-${step.id}.png`, shot);
    const decision = await options.control.escalate({
      reason,
      capabilityId: capability.id,
      stepId: step.id,
      url: observed.url,
      screenshotPath,
      observationPreview: summarize(observed),
    });
    if (decision.action === "abort") {
      const result: RunResult = {
        status: "escalated",
        interventionId: options.control.lastIntervention?.id,
        message: decision.note ?? reason,
        stepId: step.id,
        evidencePath: this.evidence.dir,
      };
      this.evidence.saveResult(result);
      return result;
    }
    return undefined;
  }

  private checkpointHolds(checkpoint: Checkpoint, observed: Observation): boolean {
    const haystack =
      checkpoint.kind === "urlIncludes"
        ? observed.url
        : checkpoint.kind === "titleIncludes"
          ? observed.title
          : `${observed.text}\n${observed.aria}`;
    return haystack.includes(checkpoint.expect);
  }

  private describeCheckpoint(checkpoint: Checkpoint): string {
    return `${checkpoint.kind} ${JSON.stringify(checkpoint.expect)}`;
  }

  private async fail(
    stepId: string,
    expected: string,
    observedText: string,
    observation?: Observation,
    code?: string,
  ): Promise<RunResult> {
    let evidencePath = this.evidence.dir;
    if (observation) {
      this.evidence.saveJson("failure-observation.json", observation);
    }
    try {
      const shot = await this.surface.screenshot();
      evidencePath = await this.evidence.saveScreenshot(`failure-${stepId}.png`, shot);
    } catch {
      // screenshot is best-effort
    }
    const result: RunResult = {
      status: "failed",
      code,
      stepId,
      expected,
      observed: observedText,
      message: `Step ${stepId} failed.`,
      evidencePath: this.evidence.dir,
    };
    this.evidence.saveResult(result);
    this.evidence.event("replay.fail", { stepId, expected, observed: observedText });
    return result;
  }
}

export function rewriteBase(url: string, baseUrl?: string): string {
  if (!baseUrl) return url;
  try {
    const original = new URL(url);
    const base = new URL(baseUrl);
    original.protocol = base.protocol;
    original.host = base.host;
    return original.toString();
  } catch {
    return url;
  }
}

function matchesDetect(state: ExceptionalState, observed: Observation): boolean {
  const { detect } = state;
  if (detect.textIncludes) {
    const blob = `${observed.text}\n${observed.aria}`;
    if (!blob.includes(detect.textIncludes)) return false;
  }
  if (detect.dialogTitle && observed.dialog !== detect.dialogTitle) return false;
  if (detect.urlIncludes && !observed.url.includes(detect.urlIncludes)) return false;
  return Boolean(detect.textIncludes || detect.dialogTitle || detect.urlIncludes);
}

function summarize(observed: Observation): string {
  return `${observed.title} | ${observed.url} | ${observed.text.slice(0, 240)}`;
}
