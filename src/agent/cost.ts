import type { LlmUsage } from "../core/llm.ts";
import type { RunMetrics } from "../core/types.ts";

/** USD per 1M tokens. Conservative public list prices as of 2026-09. */
const PRICE: Record<string, { input: number; output: number }> = {
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "claude-sonnet-4-20250514": { input: 3, output: 15 },
  "claude-3-5-sonnet-latest": { input: 3, output: 15 },
  scripted: { input: 0, output: 0 },
};

export function priceFor(model: string): { input: number; output: number } {
  if (PRICE[model]) return PRICE[model]!;
  if (/gpt-4o/i.test(model)) return PRICE["gpt-4o"]!;
  if (/claude/i.test(model)) return PRICE["claude-sonnet-4-20250514"]!;
  return { input: 0, output: 0 };
}

export function costUsd(model: string, inputTokens: number, outputTokens: number): number {
  const price = priceFor(model);
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

export function addUsage(total: LlmUsage, turn: LlmUsage | undefined): LlmUsage {
  if (!turn) return total;
  return {
    inputTokens: total.inputTokens + turn.inputTokens,
    outputTokens: total.outputTokens + turn.outputTokens,
    latencyMs: total.latencyMs + turn.latencyMs,
  };
}

export function metricsFrom(input: {
  durationMs: number;
  modelCalls: number;
  model?: string;
  usage: LlmUsage;
}): RunMetrics {
  return {
    durationMs: input.durationMs,
    modelCalls: input.modelCalls,
    inputTokens: input.usage.inputTokens,
    outputTokens: input.usage.outputTokens,
    costUsd: Number(costUsd(input.model ?? "", input.usage.inputTokens, input.usage.outputTokens).toFixed(4)),
  };
}

export function formatMetrics(label: string, model: string, metrics: RunMetrics, note?: string): string {
  const cost = metrics.modelCalls === 0 ? "$0.00" : `$${metrics.costUsd.toFixed(2)}`;
  const extra = note ? `      ${note}` : "";
  return `${label.padEnd(14)} ${model.padEnd(10)} ${(metrics.durationMs / 1000).toFixed(1)}s   ${String(metrics.modelCalls).padStart(3)} model calls   ${cost}${extra}`;
}
