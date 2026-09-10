import type { Checkpoint } from "../core/types.ts";

export const CURRENT_SCHEMA_VERSION = "1.1" as const;
export const DEFAULT_STEP_TIMEOUT_MS = 8_000;
/** Cap for recoverable (dismiss) and transient (backoff) only. Deterministic classes never retry. */
export const DEFAULT_RETRY_BUDGET = 3;
export const TRANSIENT_BACKOFF_MS = [200, 400, 800];

export const VENDOR_ANTI_CHECKPOINTS: Checkpoint[] = [
  { kind: "textIncludes", expect: "Wrong screen" },
  { kind: "textIncludes", expect: "Screen not found" },
];

export const READ_ONLY_COMPENSATION = "Nothing to undo; this capability only reads.";
export const IRREVERSIBLE_COMPENSATION =
  "A teller must reverse this in the core. Automation cannot undo Confirm.";
