import type { LedgerEntry } from "./ledger.ts";

export const DEFAULT_DRIFT_WINDOW = 20;
export const DEFAULT_FALLBACK_THRESHOLD = 0.15;
export const DEFAULT_CHECKPOINT_MISS_THRESHOLD = 0.1;
export const DEFAULT_DRIFT_SCORE_THRESHOLD = 0.12;

export type DriftReport = {
  tenantId: string;
  capabilityId?: string;
  window: number;
  runs: number;
  fallbackLocatorRate: number;
  checkpointMissRate: number;
  driftScore: number;
  threshold: number;
  needsRediscovery: boolean;
  reason: string;
};

export type DriftOptions = {
  tenantId: string;
  capabilityId?: string;
  window?: number;
  fallbackThreshold?: number;
  checkpointMissThreshold?: number;
  scoreThreshold?: number;
};

/**
 * Same machinery as per-run `needsRediscovery`, pointed at a tenant:
 * fallback-locator rate + checkpoint-miss rate over the last N runs.
 */
export function driftScore(entries: LedgerEntry[], options: DriftOptions): DriftReport {
  const window = options.window ?? DEFAULT_DRIFT_WINDOW;
  const fallbackThreshold = options.fallbackThreshold ?? DEFAULT_FALLBACK_THRESHOLD;
  const missThreshold = options.checkpointMissThreshold ?? DEFAULT_CHECKPOINT_MISS_THRESHOLD;
  const scoreThreshold = options.scoreThreshold ?? DEFAULT_DRIFT_SCORE_THRESHOLD;

  const scoped = entries.filter((entry) => {
    if (entry.tenantId !== options.tenantId) return false;
    if (options.capabilityId && entry.capabilityId !== options.capabilityId) return false;
    return true;
  });
  const slice = scoped.slice(-window);
  const runs = slice.length;
  const targeted = slice.reduce((sum, entry) => sum + (entry.targetedHits ?? 0), 0);
  const fallbacks = slice.reduce((sum, entry) => sum + (entry.fallbackHits ?? 0), 0);
  const misses = slice.filter((entry) => entry.checkpointMiss).length;
  const fallbackLocatorRate = targeted === 0 ? 0 : fallbacks / targeted;
  const checkpointMissRate = runs === 0 ? 0 : misses / runs;
  const driftScoreValue = 0.6 * fallbackLocatorRate + 0.4 * checkpointMissRate;
  const needsRediscovery =
    runs > 0 &&
    (fallbackLocatorRate >= fallbackThreshold ||
      checkpointMissRate >= missThreshold ||
      driftScoreValue >= scoreThreshold);

  let reason: string;
  if (runs === 0) {
    reason = `No ledger rows for ${options.tenantId}${options.capabilityId ? ` / ${options.capabilityId}` : ""}.`;
  } else if (needsRediscovery) {
    reason = `Tenant ${options.tenantId} drifted (fallback ${pct(fallbackLocatorRate)}, checkpoint-miss ${pct(checkpointMissRate)} over ${runs} runs). Re-discover before a customer calls.`;
  } else {
    reason = `Tenant ${options.tenantId} is within threshold (fallback ${pct(fallbackLocatorRate)}, checkpoint-miss ${pct(checkpointMissRate)} over ${runs} runs).`;
  }

  return {
    tenantId: options.tenantId,
    capabilityId: options.capabilityId,
    window,
    runs,
    fallbackLocatorRate,
    checkpointMissRate,
    driftScore: driftScoreValue,
    threshold: scoreThreshold,
    needsRediscovery,
    reason,
  };
}

function pct(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

export function checkpointMissCode(code: string | undefined): boolean {
  return (
    code === "CHECKPOINT_FAILED" ||
    code === "CHECKPOINT_AFTER_ACT" ||
    code === "PRECONDITION_FAILED" ||
    code === "PRECONDITION_LOST" ||
    code === "ANTI_CHECKPOINT"
  );
}
