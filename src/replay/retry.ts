import { DEFAULT_RETRY_BUDGET, TRANSIENT_BACKOFF_MS } from "../artifact/defaults.ts";
import type { ExceptionClass } from "../core/types.ts";

export function classRetries(classify: ExceptionClass): boolean {
  return classify === "recoverable" || classify === "transient";
}

export function retryCap(stepBudget: number | undefined): number {
  return typeof stepBudget === "number" ? stepBudget : DEFAULT_RETRY_BUDGET;
}

export function backoffMs(attempt: number, schedule: number[] = TRANSIENT_BACKOFF_MS): number {
  if (schedule.length === 0) return 0;
  return schedule[Math.min(Math.max(attempt, 1) - 1, schedule.length - 1)] ?? 0;
}

export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
