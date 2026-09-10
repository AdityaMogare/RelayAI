import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability, RunResult } from "../core/types.ts";
import { EvidenceStore } from "../evidence/store.ts";
import type { Surface } from "../core/surface.ts";
import { ReplayEngine } from "./engine.ts";

export type StabilityReport = {
  capabilityId: string;
  runs: number;
  success: number;
  business_outcome: number;
  escalated: number;
  failed: number;
  invalid_input: number;
  dry_run: number;
  needs_human: number;
  rate: number;
  fallbackRate: number;
  p50DurationMs: number;
  p95DurationMs: number;
  durationsMs: number[];
  codes: Record<string, number>;
  results: Pick<RunResult, "status" | "code" | "stepId">[];
};

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

export async function runStability(input: {
  surface: Surface;
  capability: Capability;
  inputs: Record<string, string>;
  runs: number;
  baseUrl?: string;
  approveRisky?: boolean;
  artifactPath?: string;
  contentHash?: string;
}): Promise<StabilityReport> {
  const counts = { success: 0, business_outcome: 0, escalated: 0, failed: 0, invalid_input: 0, dry_run: 0, needs_human: 0 };
  const codes: Record<string, number> = {};
  const results: StabilityReport["results"] = [];
  const durationsMs: number[] = [];
  let fallbackHits = 0;
  let targetedHits = 0;

  for (let i = 0; i < input.runs; i += 1) {
    const evidence = new EvidenceStore(
      `stability-${input.capability.id}-${i + 1}`,
      mkdtempSync(join(tmpdir(), "relay-stability-")),
    );
    const result = await new ReplayEngine(input.surface, evidence).run(input.capability, {
      inputs: input.inputs,
      baseUrl: input.baseUrl,
      approveRisky: input.approveRisky,
      artifactPath: input.artifactPath,
      contentHash: input.contentHash,
    });
    counts[result.status] += 1;
    const code = result.code ?? result.status;
    codes[code] = (codes[code] ?? 0) + 1;
    results.push({ status: result.status, code: result.code, stepId: result.stepId });
    durationsMs.push(result.metrics?.durationMs ?? 0);
    for (const hit of result.locatorHits ?? []) {
      targetedHits += 1;
      if (hit.rank > 1) fallbackHits += 1;
    }
  }

  const sorted = [...durationsMs].sort((a, b) => a - b);
  return {
    capabilityId: input.capability.id,
    runs: input.runs,
    ...counts,
    rate: input.runs === 0 ? 0 : counts.success / input.runs,
    fallbackRate: targetedHits === 0 ? 0 : fallbackHits / targetedHits,
    p50DurationMs: percentile(sorted, 50),
    p95DurationMs: percentile(sorted, 95),
    durationsMs,
    codes,
    results,
  };
}
