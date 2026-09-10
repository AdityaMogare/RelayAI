import { existsSync } from "node:fs";
import { addUsage, metricsFrom } from "./cost.ts";
import type { LlmClient, LlmUsage } from "../core/llm.ts";
import type { Surface } from "../core/surface.ts";
import type { Action, Capability, Observation, RunResult, Target } from "../core/types.ts";
import type { RecordedStep } from "../artifact/compile.ts";
import { compileArtifact } from "../artifact/compile.ts";
import { hashCapability, hashCapabilityFile } from "../artifact/hash.ts";
import { discoveryPromptHash } from "./prompt.ts";
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
  version?: number;
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
    let modelCalls = 0;
    let usage: LlmUsage = { inputTokens: 0, outputTokens: 0, latencyMs: 0 };
    const started = Date.now();

    this.evidence.event("discover.start", {
      capabilityId: options.capabilityId,
      target: options.targetUrl,
      ...this.llm.identity,
    });
    this.policy.assertUrl(options.targetUrl);
    await this.surface.act({ name: "navigate", url: options.targetUrl });

    for (let i = 0; i < maxSteps; i += 1) {
      if (this.surface.whoHasControl() !== "automation") {
        return this.finishRun(
          options,
          recorded,
          outputs,
          {
            status: "escalated",
            message: "Session is under human control.",
            outputs,
            evidencePath: this.evidence.dir,
          },
          started,
          modelCalls,
          usage,
          undefined,
        );
      }

      const observation = await this.surface.observe();
      this.policy.assertUrl(observation.url);
      const signature = `${observation.url}|${observation.title}|${observation.aria.slice(0, 200)}`;
      stuck = signature === lastSignature ? stuck + 1 : 0;
      lastSignature = signature;
      if (stuck >= 3) {
        const assisted = await this.assist(options, observation, "Repeated observation with no progress.", recorded, outputs);
        if (assisted === "abort") {
          return this.escalatedResult(options, recorded, outputs, "Repeated observation with no progress.", started, modelCalls, usage);
        }
        stuck = 0;
        continue;
      }

      this.evidence.event("discover.observe", {
        url: observation.url,
        title: observation.title,
        controls: observation.refs.map((ref) => ({ role: ref.role, name: ref.name })),
      });

      const turn = await this.llm.decide({
        goal: options.goal,
        observation,
        history,
        remainingSteps: maxSteps - i,
      });
      modelCalls += 1;
      usage = addUsage(usage, turn.usage);
      const decision = turn.decision;
      this.evidence.event("discover.decide", {
        tool: decision.tool,
        reason: decision.reason,
        role: decision.role,
        name: decision.name,
        ref: decision.ref,
        outputName: decision.outputName,
        ...this.llm.identity,
        usage: turn.usage,
      });
      history.push(`${decision.tool}: ${decision.reason}`);

      if (decision.tool === "finish") {
        Object.assign(outputs, decision.outputs ?? {});
        return this.compileAndFinish(options, recorded, outputs, decision.reason, decision.businessCode, started, modelCalls, usage);
      }

      if (decision.tool === "escalate") {
        const assisted = await this.assist(options, observation, decision.reason, recorded, outputs);
        if (assisted === "abort") {
          return this.escalatedResult(options, recorded, outputs, decision.reason, started, modelCalls, usage);
        }
        stuck = 0;
        continue;
      }

      const action = this.toAction(decision, observation);
      try {
        this.policy.assertAction(action, observation.url);
      } catch (err) {
        if (err instanceof PolicyViolation) {
          const assisted = await this.assist(options, observation, err.message, recorded, outputs);
          if (assisted === "abort") {
            return this.escalatedResult(options, recorded, outputs, err.message, started, modelCalls, usage);
          }
          continue;
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
          return this.escalatedResult(options, recorded, outputs, decisionResume.note ?? "aborted", started, modelCalls, usage);
        }
        if (decisionResume.stepDisposition === "completed_by_human") {
          const observationAfter = await this.surface.observe();
          recorded.push({
            action: { ...action, target: action.target ?? targetFromDecision(decision) },
            observationBefore: observation,
            observationAfter,
            usedLocatorName: action.target?.primary.name,
            risk,
            assistedBy: decisionResume.operatorId,
          });
          continue;
        }
      }

      const acted = await this.surface.act(action);
      this.flushPolicyBlocks();
      if (acted.extracted) this.evidence.notePii(acted.extracted);
      this.evidence.event("discover.act", {
        action: action.name,
        ok: acted.ok,
        error: acted.error,
        extracted: acted.extracted ? "[REDACTED-PII]" : undefined,
      });
      if (!acted.ok) {
        const shot = await this.surface.screenshot();
        await this.evidence.saveScreenshot("discover-failure.png", shot);
        const policy = /policy:/i.test(acted.error ?? "");
        const result: RunResult = {
          status: "failed",
          message: acted.error,
          expected: policy ? "policy allowlist" : action.name,
          observed: observation.text.slice(0, 240),
          code: policy ? "POLICY_VIOLATION" : undefined,
          outputs,
          evidencePath: this.evidence.dir,
          metrics: metricsFrom({
            durationMs: Date.now() - started,
            modelCalls,
            model: this.llm.identity.model,
            usage,
          }),
        };
        this.evidence.saveResult(result);
        return { result };
      }
      if (acted.extracted && action.outputName) {
        outputs[action.outputName] = acted.extracted;
        history[history.length - 1] += ` → ${acted.extracted}`;
      }
      const observationAfter = await this.surface.observe();
      recorded.push({
        action: { ...action, target: action.target ?? targetFromDecision(decision) },
        observationBefore: observation,
        observationAfter,
        usedLocatorName: action.target?.primary.name,
        risk,
        row: acted.row,
      });
    }

    const observation = await this.surface.observe();
    const assisted = await this.assist(options, observation, "Hit max discovery steps.", recorded, outputs);
    if (assisted === "continue") {
      return this.compileAndFinish(options, recorded, outputs, "Finished after human assistance at max steps.", undefined, started, modelCalls, usage);
    }
    return this.escalatedResult(options, recorded, outputs, "Hit max discovery steps.", started, modelCalls, usage);
  }

  private async assist(
    options: DiscoverOptions,
    observation: Observation,
    reason: string,
    recorded: RecordedStep[],
    outputs: Record<string, string>,
  ): Promise<"abort" | "continue"> {
    const shot = await this.surface.screenshot().catch(() => Buffer.from(""));
    const screenshotPath = await this.evidence.saveScreenshot("stuck.png", shot);
    if (!options.control) return "abort";
    const decision = await options.control.escalate({
      reason,
      goal: options.goal,
      url: observation.url,
      screenshotPath,
      observationPreview: observation.text.slice(0, 240),
    });
    if (decision.action === "abort") return "abort";
    const observationAfter = await this.surface.observe();
    const inferred = inferHumanAction(observation, observationAfter);
    recorded.push({
      action: inferred,
      observationBefore: observation,
      observationAfter,
      usedLocatorName: inferred.target?.primary.name,
      risk: "safe",
      assistedBy: decision.operatorId ?? "teller01",
    });
    this.evidence.event("discover.assisted", {
      operatorId: decision.operatorId,
      reason,
      action: inferred.name,
      name: inferred.target?.primary.name,
    });
    void outputs;
    return "continue";
  }

  private async compileAndFinish(
    options: DiscoverOptions,
    recorded: RecordedStep[],
    outputs: Record<string, string>,
    message: string,
    businessCode: string | undefined,
    started: number,
    modelCalls: number,
    usage: LlmUsage,
  ): Promise<DiscoverResult> {
    const metrics = metricsFrom({
      durationMs: Date.now() - started,
      modelCalls,
      model: this.llm.identity.model,
      usage,
    });
    const artifact = compileArtifact({
      goal: options.goal,
      targetUrl: options.targetUrl,
      recorded,
      outputs,
      id: options.capabilityId,
      provenance: {
        discoveredAt: new Date().toISOString(),
        discoveredBy: this.llm.identity.scripted ? "human" : "model",
        model: this.llm.identity.model,
        promptHash: discoveryPromptHash(),
        evidenceRunId: this.evidence.dir.split("/").pop(),
        goal: options.goal,
      },
    });
    if (options.version) artifact.version = options.version;
    const artifactPath = await this.store.save(artifact);
    this.evidence.classify(artifact);
    this.evidence.saveJson("artifact.json", artifact);
    const contentHash =
      artifactPath.endsWith(".json") && existsSync(artifactPath)
        ? hashCapabilityFile(artifactPath)
        : hashCapability(artifact);
    const result: RunResult = businessCode
      ? {
          status: "business_outcome",
          code: businessCode,
          message,
          outputs,
          evidencePath: this.evidence.dir,
          metrics,
        }
      : {
          status: "success",
          outputs,
          message,
          evidencePath: this.evidence.dir,
          metrics,
        };
    this.evidence.saveResult(result);
    this.evidence.event("discover.end", {
      status: result.status,
      artifactPath,
      contentHash,
      metrics,
    });
    return { result, artifact, artifactPath };
  }

  private escalatedResult(
    options: DiscoverOptions,
    recorded: RecordedStep[],
    outputs: Record<string, string>,
    message: string,
    started: number,
    modelCalls: number,
    usage: LlmUsage,
  ): DiscoverResult {
    return this.finishRun(
      options,
      recorded,
      outputs,
      {
        status: "escalated",
        message,
        outputs,
        evidencePath: this.evidence.dir,
      },
      started,
      modelCalls,
      usage,
      undefined,
    );
  }

  private finishRun(
    _options: DiscoverOptions,
    _recorded: RecordedStep[],
    _outputs: Record<string, string>,
    partial: RunResult,
    started: number,
    modelCalls: number,
    usage: LlmUsage,
    _unused?: undefined,
  ): DiscoverResult {
    const result: RunResult = {
      ...partial,
      metrics: metricsFrom({
        durationMs: Date.now() - started,
        modelCalls,
        model: this.llm.identity.model,
        usage,
      }),
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

  private flushPolicyBlocks(): void {
    const drain = (this.surface as { drainPolicyBlocks?: () => Array<Record<string, unknown>> }).drainPolicyBlocks;
    if (!drain) return;
    for (const block of drain.call(this.surface)) {
      this.evidence.event("policy.blocked", block);
    }
  }
}

function inferHumanAction(before: Observation, after: Observation): Action {
  const gone = before.refs.filter((ref) => !after.refs.some((next) => next.ref === ref.ref && next.name === ref.name));
  const clicked = gone.find((ref) => ref.role === "button" || ref.role === "link") ?? gone[0];
  if (clicked) {
    return { name: "click", target: { primary: { by: "role", role: clicked.role, name: clicked.name } } };
  }
  const screen = `${before.dialog ?? ""} ${before.aria} ${before.text}`;
  if (/attest/i.test(screen)) {
    return { name: "click", target: { primary: { by: "role", role: "button", name: "I attest" } } };
  }
  if (after.url.includes("/member/") && !before.url.includes("/member/")) {
    return { name: "click", target: { primary: { by: "role", role: "button", name: "Search" } } };
  }
  return { name: "click", target: { primary: { by: "role", role: "button", name: "Search" } } };
}

function targetFromDecision(decision: { role?: string; name?: string }): Target | undefined {
  if (!decision.role && !decision.name) return undefined;
  return { primary: { by: "role", role: decision.role ?? "generic", name: decision.name } };
}
