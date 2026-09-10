import { DEFAULT_RETRY_BUDGET, TRANSIENT_BACKOFF_MS } from "../artifact/defaults.ts";
import { expandParams, expandTarget } from "../artifact/canonical.ts";
import { assertTwoPersonApproval } from "../artifact/review.ts";
import type { ArtifactStore } from "../artifact/store.ts";
import type { Surface } from "../core/surface.ts";
import { locatorLabel } from "../core/surface.ts";
import type {
  Action,
  ArtifactStep,
  Capability,
  Checkpoint,
  ExceptionalState,
  Locator,
  LocatorHit,
  Observation,
  OutputValue,
  RunResult,
  SessionContext,
  WouldExecuteStep,
} from "../core/types.ts";
import type { ControlPlane, ResumeDecision } from "../escalation/control.ts";
import { summarizePublic } from "../evidence/observe.ts";
import type { EvidenceStore } from "../evidence/store.ts";
import { PolicyGuard, PolicyViolation } from "../policy/policy.ts";
import { outputIsPii } from "../policy/redact.ts";
import { isKilled, loadRuntime, type RuntimeConfig } from "../policy/runtime.ts";
import { resolveCredentialRef, type ResolvedCredential } from "../policy/vault.ts";
import { validateInputs } from "./inputs.ts";
import { idempotencyKeyFor, type RunLedger } from "./ledger.ts";
import { checkpointMissCode } from "./drift.ts";
import { driftFromHits, hitFromMatch } from "./locator.ts";
import { coerceOutput } from "./outputs.ts";
import { probeApplicability } from "./probe.ts";
import { backoffMs, retryCap, sleep } from "./retry.ts";
import { rewriteBase } from "./url.ts";

import type { ReplayOptions } from "./options.ts";
import { checkpointHolds, describeCheckpoint } from "./checkpoints.ts";
import { matchAnti, matchException, matchLocatorMiss, handleException } from "./classifier.ts";
import { afterRiskyHandback, escalateToHuman } from "./handoff.ts";
import { runUsed as runUsedChild, loadUsed } from "./compose.ts";

export type { ReplayOptions } from "./options.ts";
export { rewriteBase } from "./url.ts";

export class ReplayEngine {
  private currentLedger?: RunLedger;
  private inputs: Record<string, string> = {};
  private currentAudit?: {
    tenantId: string;
    memberId?: string;
    routes: string[];
    capabilityId: string;
    credentialRef?: string;
    runKey: string;
  };
  private startedAt = 0;
  private activeControl?: ControlPlane;
  private reauthed = false;
  private sessionCred?: ResolvedCredential;
  private activeOptions?: ReplayOptions;
  private currentCapability?: Capability;

  constructor(
    private readonly surface: Surface,
    private readonly evidence: EvidenceStore,
    private readonly policy = new PolicyGuard(),
  ) {}

  async run(capability: Capability, options: ReplayOptions): Promise<RunResult> {
    this.evidence.classify(capability);
    this.inputs = options.inputs;
    this.currentCapability = capability;
    this.activeOptions = options;
    if (!options.nested) this.reauthed = false;
    const tenantId = options.tenantId ?? "tenant-9";
    if (!options.nested) this.startedAt = Date.now();
    this.evidence.event("replay.start", {
      capabilityId: capability.id,
      version: capability.version,
      inputs: options.inputs,
      artifactPath: options.artifactPath,
      contentHash: options.contentHash,
      dryRun: Boolean(options.dryRun),
      nested: Boolean(options.nested),
      tenantId,
      credentialRef: capability.auth?.credentialRef,
      overlay: options.overlayTrace
        ? {
            copy: options.overlayTrace.copy,
            overrides: options.overlayTrace.overrides,
            order: options.overlayTrace.order.map((layer) => layer.layer),
          }
        : undefined,
    });
    this.activeOptions = options;
    const cred = resolveCredentialRef(capability.auth?.credentialRef, options.vault);
    this.sessionCred = cred;
    if (cred) this.evidence.notePii(cred.secret);
    const invalid = validateInputs(capability, options.inputs, this.evidence.dir);
    if (invalid) {
      this.evidence.saveResult(invalid);
      this.evidence.event("replay.end", {
        status: invalid.status,
        code: invalid.code,
        message: invalid.message,
        violations: invalid.violations,
      });
      return invalid;
    }
    const outputs: Record<string, OutputValue> = { ...(options.bag ?? {}) };
    const locatorHits: LocatorHit[] = [];
    const runKey = idempotencyKeyFor(capability, options.inputs);
    const backoffSchedule = options.backoffMs ?? TRANSIENT_BACKOFF_MS;
    const routes: string[] = [];

    const gated = this.assertGovernance(capability, options, tenantId, outputs, locatorHits);
    if (gated) return gated;
    this.currentLedger = options.ledger;
    this.currentAudit = {
      tenantId,
      memberId: options.inputs.memberId,
      routes,
      capabilityId: capability.id,
      credentialRef: capability.auth?.credentialRef,
      runKey,
    };

    const sessionBlocked = this.assertSession(capability, options.session, outputs, locatorHits);
    if (sessionBlocked) return sessionBlocked;
    const duplicate = await this.assertIdempotent(capability, options, runKey, outputs, locatorHits);
    if (duplicate) return duplicate;

    if (options.probe && !options.nested) {
      const probed = await probeApplicability(this.surface, capability, {
        baseUrl: options.baseUrl,
        inputs: options.inputs,
      });
      this.evidence.event("replay.probe", probed);
      if (!probed.applicable) {
        return this.complete(
          {
            status: "failed",
            code: "NOT_APPLICABLE",
            classify: "hard_failure",
            message: probed.reason,
            stepId: "probe",
            expected: probed.entryCheckpoint.expect,
            observed: probed.missing.join(", ") || "entry checkpoint missed",
          },
          outputs,
          locatorHits,
        );
      }
    }

    const seen = new Set(options.seen ?? []);
    if (seen.has(capability.id)) {
      return this.fail({
        stepId: "compose",
        expected: "acyclic uses",
        observedText: `cycle involving ${capability.id}`,
        observation: undefined,
        outputs,
        hits: locatorHits,
        code: "COMPOSE_CYCLE",
        classify: "hard_failure",
      });
    }
    seen.add(capability.id);

    try {
      for (const use of capability.uses) {
        const childHalt = await this.runUsed(use, capability, options, outputs, locatorHits, [...seen]);
        if (childHalt) return childHalt;
      }

      let steps = capability.steps;
      let landing = await this.surface.observe();
      landing = await this.maybeSignIn(landing, options);
      this.touch(landing.url, routes);
      const entryOk = this.checkpointHolds(capability.preconditions.entryCheckpoint, landing);
      if (!entryOk && steps[0]?.action !== "navigate") {
        return this.fail({
          stepId: "precondition",
          expected: this.describeCheckpoint(capability.preconditions.entryCheckpoint),
          observedText: summarize(landing),
          observation: landing,
          outputs,
          hits: locatorHits,
          code: "PRECONDITION_FAILED",
          classify: "hard_failure",
          message: `Capability ${capability.id} is not on its entry screen. Replay stopped before step 1.`,
        });
      }
      if (entryOk && steps[0]?.action === "navigate") {
        this.evidence.event("replay.precondition.skipNavigate", {
          capabilityId: capability.id,
          expect: capability.preconditions.entryCheckpoint.expect,
        });
        steps = steps.slice(1);
      }

      for (const step of steps) {
        let approvedThisStep = Boolean(options.approveRisky);
        let recoveries = 0;
        let transients = 0;
        let pendingRetryAction = false;
        const budget = retryCap(step.retryBudget ?? DEFAULT_RETRY_BUDGET);

        stepLoop: while (true) {
          let observed = await this.surface.observe();
          observed = await this.maybeSignIn(observed, options);
          this.touch(observed.url, routes);

          const anti = matchAnti(capability, step, observed, (check, obs) => checkpointHolds(check, obs, this.inputs));
          if (anti) {
            return this.fail({
              stepId: step.id,
              expected: `must not match ${this.describeCheckpoint(anti)}`,
              observedText: summarize(observed),
              observation: observed,
              outputs,
              hits: locatorHits,
              code: "ANTI_CHECKPOINT",
              classify: "hard_failure",
            });
          }

          const exceptional = this.matchException(capability, observed);
          if (exceptional && !pendingRetryAction) {
            const handled = await this.handleException(exceptional, observed, step.id, outputs, locatorHits);
            if (handled.kind === "stop") return handled.result;
            if (handled.kind === "retry_observe") {
              recoveries += 1;
              if (recoveries > budget) {
                return this.fail({
                  stepId: step.id,
                  expected: "interstitial dismissed within retry budget",
                  observedText: summarize(observed),
                  observation: observed,
                  outputs,
                  hits: locatorHits,
                  code: "RECOVERABLE_EXHAUSTED",
                  classify: "needs_human",
                  status: "needs_human",
                  message: `Recoverable ${exceptional.code} returned on every attempt (cap ${budget}). A person needs to look.`,
                });
              }
              this.evidence.event("replay.retry", {
                class: "recoverable",
                code: exceptional.code,
                attempt: recoveries,
                stepId: step.id,
                sameStep: true,
              });
              continue;
            }
            if (handled.kind === "reauth") {
              this.reauthed = true;
              this.evidence.event("replay.reauth", { stepId: step.id, code: exceptional.code });
              continue;
            }
            if (handled.kind === "retry_action") {
              transients += 1;
              if (transients > budget) {
                return this.fail({
                  stepId: step.id,
                  expected: "transient condition cleared within retry budget",
                  observedText: summarize(observed),
                  observation: observed,
                  outputs,
                  hits: locatorHits,
                  code: "TRANSIENT_EXHAUSTED",
                  classify: "hard_failure",
                });
              }
              const wait = backoffMs(transients, backoffSchedule);
              this.evidence.event("replay.retry", {
                class: "transient",
                code: exceptional.code,
                attempt: transients,
                stepId: step.id,
                backoffMs: wait,
              });
              await sleep(wait);
              pendingRetryAction = true;
              continue;
            }
          }
          pendingRetryAction = false;

          if (
            this.reauthed &&
            step.checkpoint &&
            !step.outputName &&
            this.checkpointHolds(step.checkpoint, observed)
          ) {
            this.reauthed = false;
            this.evidence.event("replay.reauth", { stepId: step.id, skipped: true, checkpointHeld: true });
            break;
          }

          if (step.risk === "risky" && options.dryRun) {
            return this.dryRunStop(capability, step, outputs, locatorHits, runKey);
          }

          if (step.risk === "risky" && !approvedThisStep) {
            const handback = await this.afterRiskyHandback(options, step, observed, capability, outputs, locatorHits);
            if (handback.kind === "stop") return handback.result;
            if (handback.kind === "skip") break;
            approvedThisStep = true;
          }

          const action = this.materialize(step, options);
          if (step.risk === "risky") {
            action.idempotencyKey = runKey;
            this.evidence.event("replay.idempotency", { stepId: step.id, idempotencyKey: runKey });
          }

          try {
            this.policy.assertAction(action, observed.url);
          } catch (err) {
            if (err instanceof PolicyViolation) {
              return this.fail({
                stepId: step.id,
                expected: "policy allowlist",
                observedText: err.message,
                observation: observed,
                outputs,
                hits: locatorHits,
                code: "POLICY_VIOLATION",
                classify: "hard_failure",
              });
            }
            throw err;
          }

          this.evidence.event("replay.step", {
            stepId: step.id,
            action: action.name,
            target: action.target?.primary,
            value: step.inputFrom ? `[param ${step.inputFrom}]` : undefined,
            idempotencyKey: action.idempotencyKey,
          });

          const result = await this.surface.act(action);
          const blocked = this.flushPolicyBlocks();
          this.recordLocator(step, result.usedLocator, locatorHits);
          if (blocked.length > 0 || (!result.ok && /policy:/i.test(result.error ?? ""))) {
            const after = await this.surface.observe();
            return this.fail({
              stepId: step.id,
              expected: "policy allowlist",
              observedText: result.error ?? String(blocked[0]?.path ?? "blockedbyclient"),
              observation: after,
              outputs,
              hits: locatorHits,
              code: "POLICY_VIOLATION",
              classify: "hard_failure",
              message: result.error ?? `policy blocked ${String(blocked[0]?.path ?? "request")}`,
            });
          }
          if (!result.ok) {
            if (result.retryable) {
              transients += 1;
              if (transients > budget) {
                const after = await this.surface.observe();
                return this.fail({
                  stepId: step.id,
                  expected: "transient action succeeded within retry budget",
                  observedText: result.error ?? "retryable action failed",
                  observation: after,
                  outputs,
                  hits: locatorHits,
                  code: "TRANSIENT_EXHAUSTED",
                  classify: "hard_failure",
                });
              }
              const wait = backoffMs(transients, backoffSchedule);
              this.evidence.event("replay.retry", {
                class: "transient",
                attempt: transients,
                stepId: step.id,
                backoffMs: wait,
                error: result.error,
              });
              await sleep(wait);
              pendingRetryAction = true;
              continue;
            }
            const after = await this.surface.observe();
            const miss = this.matchLocatorMiss(capability, after);
            if (miss) {
              const handled = await this.handleException(miss, after, step.id, outputs, locatorHits);
              if (handled.kind === "stop") return handled.result;
              if (handled.kind === "retry_observe" || handled.kind === "retry_action") {
                continue;
              }
            }
            const again = this.matchException(capability, after);
            if (again) {
              const handled = await this.handleException(again, after, step.id, outputs, locatorHits);
              if (handled.kind === "stop") return handled.result;
              if (handled.kind === "reauth") {
                this.reauthed = true;
                this.evidence.event("replay.reauth", { stepId: step.id, code: again.code });
                continue stepLoop;
              }
              if (handled.kind === "retry_observe" || handled.kind === "retry_action") {
                continue;
              }
            }
            return this.fail({
              stepId: step.id,
              expected: `locator ${action.target ? locatorLabel(action.target.primary) : action.name}`,
              observedText: result.error ?? "action failed",
              observation: after,
              outputs,
              hits: locatorHits,
              code: "LOCATOR_MISS",
              classify: "hard_failure",
            });
          }

          if (step.outputName) {
            const def = capability.outputs.find((output) => output.name === step.outputName);
            const coerced = coerceOutput(def, result.extracted ?? "");
            if (!coerced.ok) {
              const after = await this.surface.observe();
              return this.fail({
                stepId: step.id,
                expected: coerced.expected,
                observedText: coerced.observed,
                observation: after,
                outputs,
                hits: locatorHits,
                code: "OUTPUT_INVALID",
                classify: "hard_failure",
                message: `Step ${step.id} checkpoint-looking screen produced an untyped or empty ${step.outputName}.`,
              });
            }
            outputs[step.outputName] = coerced.value;
            const defPii = capability.outputs.find((output) => output.name === step.outputName);
            if (defPii && outputIsPii(defPii) && result.extracted) this.evidence.notePii(result.extracted);
          }

          if (step.checkpoint) {
            let after = await this.maybeSignIn(await this.surface.observe(), options);
            const antiAfter = this.matchAnti(capability, step, after);
            if (antiAfter) {
              return this.fail({
                stepId: step.id,
                expected: `must not match ${this.describeCheckpoint(antiAfter)}`,
                observedText: summarize(after),
                observation: after,
                outputs,
                hits: locatorHits,
                code: "ANTI_CHECKPOINT",
                classify: "hard_failure",
                ambiguous: step.risk === "risky",
                idempotencyKey: action.idempotencyKey,
              });
            }
            if (!this.checkpointHolds(step.checkpoint, after)) {
              const again = this.matchException(capability, after);
              if (again) {
                const handled = await this.handleException(again, after, step.id, outputs, locatorHits);
                if (handled.kind === "stop") return handled.result;
                if (handled.kind === "reauth") {
                  this.reauthed = true;
                  this.evidence.event("replay.reauth", { stepId: step.id, code: again.code });
                  continue stepLoop;
                }
                if (handled.kind === "retry_observe" || handled.kind === "retry_action") {
                  continue stepLoop;
                }
              }
              const ambiguous = step.risk === "risky";
              return this.fail({
                stepId: step.id,
                expected: this.describeCheckpoint(step.checkpoint),
                observedText: summarize(after),
                observation: after,
                outputs,
                hits: locatorHits,
                code: ambiguous ? "CHECKPOINT_AFTER_ACT" : "CHECKPOINT_FAILED",
                classify: "hard_failure",
                ambiguous,
                idempotencyKey: action.idempotencyKey,
                message: ambiguous
                  ? `Step ${step.id} returned ok but the checkpoint did not hold. The side effect may or may not have occurred; retry with idempotency key ${runKey}.`
                  : `Step ${step.id} failed.`,
              });
            }
          }
          break;
        }
      }

      const finalObs = await this.surface.observe();
      const finalAnti = this.matchAnti(capability, undefined, finalObs);
      if (finalAnti) {
        return this.fail({
          stepId: "success",
          expected: `must not match ${this.describeCheckpoint(finalAnti)}`,
          observedText: summarize(finalObs),
          observation: finalObs,
          outputs,
          hits: locatorHits,
          code: "ANTI_CHECKPOINT",
          classify: "hard_failure",
        });
      }
      const finalEx = this.matchException(capability, finalObs);
      if (finalEx) {
        const handled = await this.handleException(finalEx, finalObs, "success", outputs, locatorHits);
        if (handled.kind === "stop") return handled.result;
      }
      if (!this.checkpointHolds(capability.success.checkpoint, finalObs)) {
        return this.fail({
          stepId: "success",
          expected: this.describeCheckpoint(capability.success.checkpoint),
          observedText: summarize(finalObs),
          observation: finalObs,
          outputs,
          hits: locatorHits,
          code: "CHECKPOINT_FAILED",
          classify: "hard_failure",
        });
      }

      for (const output of capability.outputs) {
        if (outputs[output.name] !== undefined) continue;
        const extracted = await this.surface.act({
          name: "extract",
          target: output.locator,
        });
        this.recordLocator(
          { id: `output-${output.name}`, target: output.locator },
          extracted.usedLocator,
          locatorHits,
        );
        const coerced = coerceOutput(output, extracted.extracted ?? "");
        if (!coerced.ok) {
          return this.fail({
            stepId: `output-${output.name}`,
            expected: coerced.expected,
            observedText: coerced.observed,
            observation: finalObs,
            outputs,
            hits: locatorHits,
            code: "OUTPUT_INVALID",
            classify: "hard_failure",
          });
        }
        outputs[output.name] = coerced.value;
      }

      const result = this.complete(
        {
          status: "success",
          message: "Capability completed and success checkpoint held.",
          idempotencyKey: mutates(capability) ? runKey : undefined,
        },
        outputs,
        locatorHits,
      );
      return result;
    } catch (err) {
      const observed = await this.surface.observe().catch(() => undefined);
      return this.fail({
        stepId: "uncaught",
        expected: "run completed without error",
        observedText: err instanceof Error ? err.message : String(err),
        observation: observed,
        outputs,
        hits: locatorHits,
        code: "UNCAUGHT",
        classify: "hard_failure",
      });
    }
  }

  private assertGovernance(
    capability: Capability,
    options: ReplayOptions,
    tenantId: string,
    outputs: Record<string, OutputValue>,
    hits: LocatorHit[],
  ): RunResult | undefined {
    const runtime = options.runtime ?? loadRuntime();
    const killed = isKilled(runtime, tenantId, capability.id);
    if (killed) {
      return this.complete(
        {
          status: "failed",
          code: "KILL_SWITCH",
          classify: "hard_failure",
          message: killed,
          stepId: "governance",
        },
        outputs,
        hits,
      );
    }
    try {
      options.limiter?.assert(tenantId, capability.id);
    } catch (err) {
      return this.complete(
        {
          status: "failed",
          code: "RATE_LIMIT",
          classify: "hard_failure",
          message: err instanceof Error ? err.message : String(err),
          stepId: "governance",
        },
        outputs,
        hits,
      );
    }
    try {
      assertTwoPersonApproval(capability);
    } catch (err) {
      return this.complete(
        {
          status: "failed",
          code: "APPROVAL_REQUIRED",
          classify: "hard_failure",
          message: err instanceof Error ? err.message : String(err),
          stepId: "governance",
        },
        outputs,
        hits,
      );
    }
    return undefined;
  }

  private touch(url: string, routes: string[]): void {
    const path = pathnameOf(url);
    if (path && !routes.includes(path)) routes.push(path);
  }

  private assertSession(
    capability: Capability,
    session: SessionContext | undefined,
    outputs: Record<string, OutputValue>,
    hits: LocatorHit[],
  ): RunResult | undefined {
    const resolved = session ?? { authenticated: true, role: "teller" };
    if (capability.preconditions.requiresSession && !resolved.authenticated) {
      return this.complete(
        {
          status: "failed",
          code: "PRECONDITION_FAILED",
          message: `Capability ${capability.id} requires an authenticated session.`,
          expected: "requiresSession: true",
          observed: "authenticated: false",
        },
        outputs,
        hits,
      );
    }
    const requiredRole = capability.preconditions.requiresRole;
    if (requiredRole && resolved.role !== requiredRole) {
      return this.complete(
        {
          status: "failed",
          code: "PRECONDITION_FAILED",
          message: `Capability ${capability.id} requires role ${requiredRole}.`,
          expected: `requiresRole: ${requiredRole}`,
          observed: resolved.role ?? "none",
        },
        outputs,
        hits,
      );
    }
    return undefined;
  }

  private async assertIdempotent(
    capability: Capability,
    options: ReplayOptions,
    runKey: string,
    outputs: Record<string, OutputValue>,
    hits: LocatorHit[],
  ): Promise<RunResult | undefined> {
    if (!mutates(capability) || !options.ledger || options.dryRun) return undefined;
    const prior = await options.ledger.find(capability.id, runKey);
    if (!prior) return undefined;
    this.evidence.event("replay.idempotency.conflict", {
      capabilityId: capability.id,
      priorAt: prior.at,
      idempotencyKey: runKey,
    });
    return this.complete(
      {
        status: "failed",
        code: "IDEMPOTENCY_CONFLICT",
        message: `Capability ${capability.id} already completed at ${prior.at}. Compensation: ${capability.sideEffects.compensation}`,
        expected: "no prior successful run for this idempotency key",
        observed: prior.at,
        idempotencyKey: runKey,
      },
      outputs,
      hits,
    );
  }

  private async runUsed(
    use: Capability["uses"][number],
    parent: Capability,
    options: ReplayOptions,
    outputs: Record<string, OutputValue>,
    hits: LocatorHit[],
    seen: string[],
  ): Promise<RunResult | undefined> {
    return runUsedChild({
      use,
      parent,
      options,
      outputs,
      hits,
      seen,
      evidence: this.evidence,
      observe: () => this.surface.observe(),
      checkpointHolds: (checkpoint, observed) => this.checkpointHolds(checkpoint, observed),
      run: (capability, next) => this.run(capability, next),
      currentAudit: this.currentAudit,
      getAudit: () => this.currentAudit,
      setAudit: (audit) => {
        this.currentAudit = audit as typeof this.currentAudit;
      },
      currentLedger: this.currentLedger,
      setLedger: (ledger) => {
        this.currentLedger = ledger;
      },
    });
  }

  private async loadUsed(id: string, catalog?: ArtifactStore, tenantId?: string): Promise<Capability> {
    return loadUsed(id, catalog, tenantId);
  }

  private recordLocator(
    step: Pick<ArtifactStep, "id" | "target">,
    usedLocator: Locator | undefined,
    hits: LocatorHit[],
  ): void {
    const hit = hitFromMatch(step.id, step.target, usedLocator);
    if (!hit) return;
    hits.push(hit);
    this.evidence.event("replay.locator", {
      stepId: hit.stepId,
      rank: hit.rank,
      by: hit.by,
      locator: hit.locator,
      primary: step.target?.primary,
      fellBack: hit.rank > 1,
    });
    if (hit.rank > 1) {
      this.evidence.event("replay.drift", {
        stepId: hit.stepId,
        rank: hit.rank,
        by: hit.by,
        needsRediscovery: true,
        confidence: driftFromHits(hits).confidence,
      });
    }
  }

  private flushPolicyBlocks(): Array<Record<string, unknown>> {
    const drain = (this.surface as { drainPolicyBlocks?: () => Array<Record<string, unknown>> }).drainPolicyBlocks;
    if (!drain) return [];
    const blocks = drain.call(this.surface);
    for (const block of blocks) {
      this.evidence.event("policy.blocked", block);
    }
    return blocks;
  }

  private dryRunStop(
    capability: Capability,
    stoppedAt: ArtifactStep,
    outputs: Record<string, OutputValue>,
    hits: LocatorHit[],
    idempotencyKey: string,
  ): RunResult {
    const remaining = capability.steps.slice(capability.steps.indexOf(stoppedAt));
    const wouldExecute: WouldExecuteStep[] = remaining.map((step) => ({
      stepId: step.id,
      action: step.action,
      risk: step.risk,
      target: step.target?.primary,
      note: step.note,
    }));
    this.evidence.event("replay.dry_run", {
      stoppedAt: stoppedAt.id,
      wouldExecute,
      idempotencyKey,
    });
    const label = stoppedAt.target ? locatorLabel(stoppedAt.target.primary) : stoppedAt.action;
    return this.complete(
      {
        status: "dry_run",
        stepId: stoppedAt.id,
        wouldExecute,
        idempotencyKey,
        message: `Dry-run stopped before irreversible step ${stoppedAt.id} (${stoppedAt.action} ${label}). No irreversible action was taken.`,
      },
      outputs,
      hits,
    );
  }

  private async maybeSignIn(observed: Observation, options: ReplayOptions): Promise<Observation> {
    const cred = this.sessionCred;
    if (!cred || options.nested) return observed;
    if (!isLoginScreen(observed)) return observed;
    this.evidence.event("replay.session", {
      credentialRef: cred.ref,
      username: cred.username,
      action: "sign-in",
    });
    const typedUser = await this.surface.act({
      name: "type",
      target: { primary: { by: "role", role: "textbox", name: "Username" } },
      value: cred.username,
    });
    if (!typedUser.ok) return observed;
    await this.surface.act({
      name: "type",
      target: { primary: { by: "role", role: "textbox", name: "Password" } },
      value: cred.secret,
    });
    await this.surface.act({
      name: "click",
      target: { primary: { by: "role", role: "button", name: "Sign In" } },
    });
    return this.surface.observe();
  }

  private materialize(step: ArtifactStep, options: ReplayOptions): Action {
    let value = step.value;
    if (step.inputFrom?.startsWith("parameters.")) {
      const key = step.inputFrom.slice("parameters.".length);
      value = options.inputs[key];
    }
    return {
      name: step.action,
      target: expandTarget(step.target, options.inputs),
      value,
      url: step.url ? rewriteBase(expandParams(step.url, options.inputs), options.baseUrl) : undefined,
      outputName: step.outputName,
      timeoutMs: step.timeoutMs,
    };
  }

  private matchException(capability: Capability, observed: Observation): ExceptionalState | undefined {
    return matchException(capability, observed);
  }

  private matchLocatorMiss(capability: Capability, observed: Observation): ExceptionalState | undefined {
    return matchLocatorMiss(capability, observed);
  }

  private matchAnti(capability: Capability, step: ArtifactStep | undefined, observed: Observation): Checkpoint | undefined {
    return matchAnti(capability, step, observed, (check, obs) => this.checkpointHolds(check, obs));
  }

  private async handleException(
    state: ExceptionalState,
    observed: Observation,
    stepId: string,
    outputs: Record<string, OutputValue>,
    hits: LocatorHit[],
  ) {
    return handleException(
      {
        surface: this.surface,
        evidence: this.evidence,
        activeControl: this.activeOptions?.control ?? this.activeControl,
        currentCapability: this.currentCapability,
        currentAudit: this.currentAudit,
        escalateToHuman: (control, step, obs, capability, reason) =>
          this.escalateToHuman(control, step, obs, capability, reason),
        complete: (partial, out, locatorHits) => this.complete(partial, out, locatorHits),
        fail: (opts) => this.fail(opts),
      },
      state,
      observed,
      stepId,
      outputs,
      hits,
    );
  }

  private async afterRiskyHandback(
    options: ReplayOptions,
    step: ArtifactStep,
    observed: Observation,
    capability: Capability,
    outputs: Record<string, OutputValue>,
    hits: LocatorHit[],
  ) {
    return afterRiskyHandback(
      {
        surface: this.surface,
        evidence: this.evidence,
        matchException: (cap, obs) => this.matchException(cap, obs),
        handleException: (state, obs, stepId, out, locatorHits) =>
          this.handleException(state, obs, stepId, out, locatorHits),
        checkpointHolds: (checkpoint, obs) => this.checkpointHolds(checkpoint, obs),
        describeCheckpoint: (checkpoint) => this.describeCheckpoint(checkpoint),
        complete: (partial, out, locatorHits) => this.complete(partial, out, locatorHits),
        fail: (opts) => this.fail(opts),
      },
      options,
      step,
      observed,
      capability,
      outputs,
      hits,
    );
  }

  private async escalateToHuman(
    control: ControlPlane,
    step: ArtifactStep,
    observed: Observation,
    capability: Capability,
    reason: string,
  ): Promise<ResumeDecision> {
    return escalateToHuman(
      {
        surface: this.surface,
        evidence: this.evidence,
        describeCheckpoint: (checkpoint) => this.describeCheckpoint(checkpoint),
      },
      control,
      step,
      observed,
      capability,
      reason,
    );
  }

  private checkpointHolds(checkpoint: Checkpoint, observed: Observation): boolean {
    return checkpointHolds(checkpoint, observed, this.inputs);
  }

  private describeCheckpoint(checkpoint: Checkpoint): string {
    return describeCheckpoint(checkpoint, this.inputs);
  }

  private async fail(opts: {
    stepId: string;
    expected: string;
    observedText: string;
    observation: Observation | undefined;
    outputs: Record<string, OutputValue>;
    hits: LocatorHit[];
    code?: string;
    classify?: RunResult["classify"];
    status?: "failed" | "needs_human";
    ambiguous?: boolean;
    idempotencyKey?: string;
    message?: string;
  }): Promise<RunResult> {
    if (opts.observation) {
      this.evidence.saveObservation("failure-observation.json", opts.observation);
    }
    try {
      const shot = await this.surface.screenshot();
      await this.evidence.saveScreenshot(`failure-${opts.stepId}.png`, shot);
    } catch {
      // screenshot is best-effort
    }
    this.evidence.event("replay.fail", {
      stepId: opts.stepId,
      expected: opts.expected,
      observed: opts.observedText,
      code: opts.code,
      classify: opts.classify,
      ambiguous: opts.ambiguous,
      idempotencyKey: opts.idempotencyKey,
    });
    return this.complete(
      {
        status: opts.status ?? "failed",
        classify: opts.classify,
        code: opts.code,
        stepId: opts.stepId,
        expected: opts.expected,
        observed: opts.observedText,
        message: opts.message ?? `Step ${opts.stepId} failed.`,
        ambiguous: opts.ambiguous,
        idempotencyKey: opts.idempotencyKey,
      },
      opts.outputs,
      opts.hits,
    );
  }

  private complete(partial: Omit<RunResult, "outputs" | "evidencePath">, outputs: Record<string, OutputValue>, hits: LocatorHit[]): RunResult {
    const drift = driftFromHits(hits);
    const result: RunResult = {
      ...partial,
      outputs,
      locatorHits: hits,
      needsRediscovery: drift.needsRediscovery,
      confidence: drift.confidence,
      evidencePath: this.evidence.dir,
      metrics: {
        durationMs: this.startedAt ? Date.now() - this.startedAt : 0,
        modelCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      },
    };
    this.evidence.saveResult(result);
    this.evidence.event("replay.end", {
      status: result.status,
      code: result.code,
      classify: result.classify,
      outputs: result.outputs,
      needsRediscovery: result.needsRediscovery,
      confidence: result.confidence,
      locatorHits: hits.map((hit) => ({ stepId: hit.stepId, rank: hit.rank, by: hit.by })),
      tenantId: this.currentAudit?.tenantId,
      routes: this.currentAudit?.routes,
    });
    if (this.currentLedger && !this.currentAudit) {
      // nested/incomplete
    }
    void this.currentLedger?.append({
      at: new Date().toISOString(),
      capabilityId: this.currentAudit?.capabilityId ?? "unknown",
      idempotencyKey: this.currentAudit?.runKey ?? result.idempotencyKey ?? "",
      status: result.status,
      runId: this.evidence.dir.split("/").pop() ?? "run",
      tenantId: this.currentAudit?.tenantId,
      memberId: this.currentAudit?.memberId,
      credentialRef: this.currentAudit?.credentialRef,
      routes: [...(this.currentAudit?.routes ?? [])],
      fallbackHits: hits.filter((hit) => hit.rank > 1).length,
      targetedHits: hits.length,
      checkpointMiss: checkpointMissCode(result.code),
      needsRediscovery: result.needsRediscovery,
      code: result.code,
    });
    return result;
  }
}

function isLoginScreen(observed: Observation): boolean {
  if (/session expired/i.test(observed.text)) return false;
  if (observed.url.includes("/login")) return true;
  const blob = `${observed.text}\n${observed.aria}`.toLowerCase();
  return blob.includes("password") && (blob.includes("sign in") || blob.includes("teller sign-on"));
}

function mutates(capability: Capability): boolean {
  return capability.sideEffects.kind !== "none";
}

function summarize(observed: Observation): string {
  return summarizePublic(observed);
}

function pathnameOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
