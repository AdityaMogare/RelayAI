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
  rate: number;
  codes: Record<string, number>;
  results: Pick<RunResult, "status" | "code" | "stepId">[];
};

export async function runStability(input: {
  surface: Surface;
  capability: Capability;
  inputs: Record<string, string>;
  runs: number;
  baseUrl?: string;
  approveRisky?: boolean;
}): Promise<StabilityReport> {
  const counts = { success: 0, business_outcome: 0, escalated: 0, failed: 0 };
  const codes: Record<string, number> = {};
  const results: StabilityReport["results"] = [];

  for (let i = 0; i < input.runs; i += 1) {
    const evidence = new EvidenceStore(
      `stability-${input.capability.id}-${i + 1}`,
      mkdtempSync(join(tmpdir(), "relay-stability-")),
    );
    const result = await new ReplayEngine(input.surface, evidence).run(input.capability, {
      inputs: input.inputs,
      baseUrl: input.baseUrl,
      approveRisky: input.approveRisky,
    });
    counts[result.status] += 1;
    const code = result.code ?? result.status;
    codes[code] = (codes[code] ?? 0) + 1;
    results.push({ status: result.status, code: result.code, stepId: result.stepId });
  }

  return {
    capabilityId: input.capability.id,
    runs: input.runs,
    ...counts,
    rate: input.runs === 0 ? 0 : counts.success / input.runs,
    codes,
    results,
  };
}
