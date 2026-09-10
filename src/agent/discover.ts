import type { LlmClient } from "../core/llm.ts";
import type { Surface } from "../core/surface.ts";
import type { Action, Capability, Observation, RunResult, Target } from "../core/types.ts";
import type { RecordedStep } from "../artifact/compile.ts";
import { compileArtifact } from "../artifact/compile.ts";
import type { ArtifactStore } from "../artifact/store.ts";
import type { ControlPlane } from "../escalation/control.ts";
import type { EvidenceStore } from "../evidence/store.ts";
import { PolicyGuard, PolicyViolation } from "../policy/policy.ts";
import type { WebSurface } from "../surfaces/web.ts";

export type DiscoverOptions = {
  goal: string;
  targetUrl: string;
  maxSteps?: number;
  control?: ControlPlane;
  capabilityId?: string;
};

export type DiscoverResult = {
  result: RunResult;
  artifact?: Capability;
  artifactPath?: string;
};

export class DiscoveryAgent {
  constructor(
    private readonly surface: Surface,
    private readonly llm: LlmClient,
    private readonly store: ArtifactStore,
    private readonly evidence: EvidenceStore,
    private readonly policy = new PolicyGuard(),
  ) {}

  async run(options: DiscoverOptions): Promise<DiscoverResult> {
    const maxSteps = options.maxSteps ?? 12;
    const recorded: RecordedStep[] = [];
    const history: string[] = [];
    const outputs: Record<string, string> = {};
    let lastSignature = "";
    let stuck = 0;

    this.evidence.event("discover.start", {
      goal: options.goal,
      target: options.targetUrl,
      ...this.llm.identity,
    });
    this.policy.assertUrl(options.targetUrl);
    await this.surface.act({ name: "navigate", url: options.targetUrl });

    for (let i = 0; i < maxSteps; i += 1) {
      if (this.surface.whoHasControl() !== "automation") {
        return {
          result: {
            status: "escalated",
            message: "Session is under human control.",
            evidencePath: this.evidence.dir,
          },
        };
      }

      const observation = await this.surface.observe();
      this.policy.assertUrl(observation.url);
      const signature = `${observation.url}|${observation.title}|${observation.aria.slice(0, 200)}`;
      stuck = signature === lastSignature ? stuck + 1 : 0;
      lastSignature = signature;
      if (stuck >= 3) {
        return this.escalateAndStop(options, observation, "Repeated observation with no progress.");
      }

      this.evidence.event("discover.observe", {
        url: observation.url,
        title: observation.title,
        aria: observation.aria.slice(0, 2000),
      });

      const turn = await this.llm.decide({
        goal: options.goal,
        observation,
        history,
        remainingSteps: maxSteps - i,
      });
      const decision = turn.decision;
      this.evidence.event("discover.decide", {
        tool: decision.tool,
        reason: decision.reason,
        role: decision.role,
        name: decision.name,
        ref: decision.ref,
        outputName: decision.outputName,
        ...this.llm.identity,
      });
      history.push(`${decision.tool}: ${decision.reason}`);

      if (decision.tool === "finish") {
        Object.assign(outputs, decision.outputs ?? {});
        const artifact = compileArtifact({
          goal: options.goal,
          targetUrl: options.targetUrl,
          recorded,
          outputs,
          id: options.capabilityId,
        });
        const artifactPath = await this.store.save(artifact);
        this.evidence.saveJson("artifact.json", artifact);
        const result: RunResult = decision.businessCode
          ? {
              status: "business_outcome",
              code: decision.businessCode,
              message: decision.reason,
              outputs,
              evidencePath: this.evidence.dir,
            }
          : {
              status: "success",
              outputs,
              message: decision.reason,
              evidencePath: this.evidence.dir,
            };
        this.evidence.saveResult(result);
        this.evidence.event("discover.end", { status: result.status, artifactPath });
        return { result, artifact, artifactPath };
      }

      if (decision.tool === "escalate") {
        return this.escalateAndStop(options, observation, decision.reason);
      }

      const action = this.toAction(decision, observation);
      try {
        this.policy.assertAction(action, observation.url);
      } catch (err) {
        if (err instanceof PolicyViolation) {
          return this.escalateAndStop(options, observation, err.message);
        }
        throw err;
      }

      const risk = this.policy.riskFor(action, action.target?.primary.name);
      if (risk === "risky" && options.control) {
        const shot = await this.surface.screenshot();
        const screenshotPath = await this.evidence.saveScreenshot("risky.png", shot);
        const decisionResume = await options.control.escalate({
          reason: `Discovery wants a risky action: ${action.target?.primary.name ?? action.name}`,
          goal: options.goal,
          url: observation.url,
          screenshotPath,
          observationPreview: observation.text.slice(0, 240),
        });
        if (decisionResume.action === "abort") {
          return {
            result: {
              status: "escalated",
              message: decisionResume.note,
              evidencePath: this.evidence.dir,
            },
          };
        }
      }

      const acted = await this.surface.act(action);
      this.evidence.event("discover.act", {
        action: action.name,
        ok: acted.ok,
        error: acted.error,
        extracted: acted.extracted,
      });
      if (!acted.ok) {
        const shot = await this.surface.screenshot();
        await this.evidence.saveScreenshot("discover-failure.png", shot);
        const result: RunResult = {
          status: "failed",
          message: acted.error,
          expected: action.name,
          observed: observation.text.slice(0, 240),
          evidencePath: this.evidence.dir,
        };
        this.evidence.saveResult(result);
        return { result };
      }
      if (acted.extracted && action.outputName) {
        outputs[action.outputName] = acted.extracted;
        history[history.length - 1] += ` → ${acted.extracted}`;
      }
      recorded.push({
        action: { ...action, target: action.target ?? targetFromDecision(decision) },
        observationBefore: observation,
        usedLocatorName: action.target?.primary.name,
        risk,
      });
    }

    const observation = await this.surface.observe();
    return this.escalateAndStop(options, observation, "Hit max discovery steps.");
  }

  private async escalateAndStop(
    options: DiscoverOptions,
    observation: Observation,
    reason: string,
  ): Promise<DiscoverResult> {
    const shot = await this.surface.screenshot().catch(() => Buffer.from(""));
    const screenshotPath = await this.evidence.saveScreenshot("stuck.png", shot);
    if (options.control) {
      const decision = await options.control.escalate({
        reason,
        goal: options.goal,
        url: observation.url,
        screenshotPath,
        observationPreview: observation.text.slice(0, 240),
      });
      if (decision.action === "resume") {
        return {
          result: {
            status: "escalated",
            message: `Human resumed after: ${reason}`,
            evidencePath: this.evidence.dir,
          },
        };
      }
    }
    const result: RunResult = {
      status: "escalated",
      message: reason,
      evidencePath: this.evidence.dir,
    };
    this.evidence.saveResult(result);
    return { result };
  }

  private toAction(
    decision: {
      tool: string;
      ref?: string;
      role?: string;
      name?: string;
      text?: string;
      value?: string;
      outputName?: string;
    },
    _observation: Observation,
  ): Action {
    const resolved =
      decision.ref && "resolveRef" in this.surface
        ? (this.surface as WebSurface).resolveRef(decision.ref)
        : undefined;
    const target: Target | undefined = resolved
      ? { primary: resolved }
      : decision.role || decision.name
        ? {
            primary: {
              by: "role",
              role: decision.role ?? "generic",
              name: decision.name,
            },
          }
        : undefined;
    if (decision.tool === "dismiss") {
      return { name: "dismiss", target };
    }
    if (decision.tool === "type") {
      return { name: "type", target, value: decision.text ?? decision.value };
    }
    if (decision.tool === "select") {
      return { name: "select", target, value: decision.text ?? decision.value };
    }
    if (decision.tool === "extract") {
      return { name: "extract", target, outputName: decision.outputName };
    }
    return { name: "click", target };
  }
}

function targetFromDecision(decision: { role?: string; name?: string }): Target | undefined {
  if (!decision.role && !decision.name) return undefined;
  return { primary: { by: "role", role: decision.role ?? "generic", name: decision.name } };
}
