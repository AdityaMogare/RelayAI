import { RelayError } from "../core/errors.ts";
import type { ArtifactStep, Capability, Checkpoint } from "../core/types.ts";
import {
  CURRENT_SCHEMA_VERSION,
  DEFAULT_RETRY_BUDGET,
  DEFAULT_STEP_TIMEOUT_MS,
  IRREVERSIBLE_COMPENSATION,
  READ_ONLY_COMPENSATION,
  VENDOR_ANTI_CHECKPOINTS,
} from "./defaults.ts";

/**
 * Schema migration policy
 *
 * 1.x is additive. `migrate()` upgrades 1.0 → 1.1 by filling new required
 * fields (sideEffects, preconditions, uses, provenance, per-step timeout/retry).
 * On-disk 1.0 files keep loading. After migrate, in-memory artifacts are 1.1.
 *
 * 2.0 is a breaking rewrite (new step vocabulary, relocated contract). This
 * engine does not guess: it throws `UNSUPPORTED_SCHEMA`. The 4,000 recorded
 * 1.x artifacts stay loadable until a dedicated 2.0 migrator exists; they are
 * not silently dropped and they are not half-applied.
 *
 * Unknown versions fail closed. Never persist a migrated blob unless a human
 * re-saves it — load-time migrate is a read adapter, not a rewrite of git.
 */
export class UnsupportedSchemaError extends RelayError {
  constructor(message: string) {
    super("UNSUPPORTED_SCHEMA", message);
  }
}

export function migrate(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const rec = raw as Record<string, unknown>;
  const version = rec.schemaVersion;

  if (version === CURRENT_SCHEMA_VERSION) {
    return fillStepDefaults(rec);
  }
  if (version === "1.0") {
    return migrate10to11(rec);
  }
  if (typeof version === "string" && /^[0-9]+/.test(version)) {
    const major = Number(version.split(".")[0]);
    if (major >= 2) {
      throw new UnsupportedSchemaError(
        `UNSUPPORTED_SCHEMA: capability ${String(rec.id ?? "unknown")} is schemaVersion ${version}. This engine reads 1.x (migrates 1.0 → ${CURRENT_SCHEMA_VERSION}). Re-discover or run a 2.0 migrator; existing 1.x artifacts stay loadable until then.`,
      );
    }
  }
  throw new UnsupportedSchemaError(
    `UNSUPPORTED_SCHEMA: capability ${String(rec.id ?? "unknown")} has schemaVersion ${JSON.stringify(version)}. Supported: "1.0" (migrated) and "${CURRENT_SCHEMA_VERSION}".`,
  );
}

function migrate10to11(rec: Record<string, unknown>): Record<string, unknown> {
  const steps = withStepDefaults(rec.steps);
  const hasRisky = steps.some((step) => step.risk === "risky");
  const params = Array.isArray(rec.parameters)
    ? (rec.parameters as { name?: string }[]).map((p) => p.name).filter((n): n is string => Boolean(n))
    : [];

  const outputs = withPiiOutputs(rec.outputs);

  return {
    ...rec,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    steps,
    outputs,
    auth: rec.auth ?? { credentialRef: "vault://tenant-9/teller" },
    sideEffects: rec.sideEffects ?? {
      kind: hasRisky ? "irreversible" : "none",
      compensation: hasRisky ? IRREVERSIBLE_COMPENSATION : READ_ONLY_COMPENSATION,
    },
    preconditions: rec.preconditions ?? {
      requiresSession: true,
      requiresRole: "teller",
      entryCheckpoint: firstCheckpoint(steps) ?? successCheckpoint(rec),
    },
    uses: rec.uses ?? [],
    provenance: rec.provenance ?? {
      discoveredAt: "1970-01-01T00:00:00.000Z",
      discoveredBy: "human",
    },
    idempotencyKeyFrom: rec.idempotencyKeyFrom ?? (hasRisky ? params : undefined),
    antiCheckpoints: rec.antiCheckpoints ?? VENDOR_ANTI_CHECKPOINTS,
  };
}

function fillStepDefaults(rec: Record<string, unknown>): Record<string, unknown> {
  return {
    ...rec,
    steps: withStepDefaults(rec.steps),
    outputs: withPiiOutputs(rec.outputs),
    auth: rec.auth ?? { credentialRef: "vault://tenant-9/teller" },
    antiCheckpoints: rec.antiCheckpoints ?? VENDOR_ANTI_CHECKPOINTS,
  };
}

function withPiiOutputs(outputs: unknown): unknown {
  if (!Array.isArray(outputs)) return outputs;
  return outputs.map((output) => {
    const rec = output && typeof output === "object" ? (output as Record<string, unknown>) : {};
    const name = typeof rec.name === "string" ? rec.name : "";
    const pii =
      rec.pii === true ||
      rec.type === "money" ||
      /balance|amount|name|ssn|account|confirmation/i.test(name);
    return { ...rec, pii };
  });
}

function withStepDefaults(steps: unknown): ArtifactStep[] {
  if (!Array.isArray(steps)) return [];
  return steps.map((step) => {
    const rec = step && typeof step === "object" ? (step as Record<string, unknown>) : {};
    return {
      ...(rec as unknown as ArtifactStep),
      timeoutMs: typeof rec.timeoutMs === "number" ? rec.timeoutMs : DEFAULT_STEP_TIMEOUT_MS,
      retryBudget: typeof rec.retryBudget === "number" ? rec.retryBudget : DEFAULT_RETRY_BUDGET,
    };
  });
}

function firstCheckpoint(steps: ArtifactStep[]): Checkpoint | undefined {
  return steps.find((step) => step.checkpoint)?.checkpoint;
}

function successCheckpoint(rec: Record<string, unknown>): Checkpoint {
  const success = rec.success;
  if (success && typeof success === "object" && "checkpoint" in success) {
    return (success as Capability["success"]).checkpoint;
  }
  return { kind: "textIncludes", expect: "Member" };
}
