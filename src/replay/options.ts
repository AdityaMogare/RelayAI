import type { ArtifactStore } from "../artifact/store.ts";
import type { OutputValue, SessionContext } from "../core/types.ts";
import type { ControlPlane } from "../escalation/control.ts";
import type { OverlayTrace } from "../overlay/resolve.ts";
import type { RateLimiter, RuntimeConfig } from "../policy/runtime.ts";
import type { Vault } from "../policy/vault.ts";
import type { RunLedger } from "./ledger.ts";

export type ReplayOptions = {
  inputs: Record<string, string>;
  approveRisky?: boolean;
  /** Execute until an irreversible step, then report what would happen instead of doing it. */
  dryRun?: boolean;
  baseUrl?: string;
  control?: ControlPlane;
  artifactPath?: string;
  contentHash?: string;
  backoffMs?: number[];
  ledger?: RunLedger;
  catalog?: ArtifactStore;
  session?: SessionContext;
  bag?: Record<string, OutputValue>;
  nested?: boolean;
  seen?: string[];
  tenantId?: string;
  vault?: Vault;
  runtime?: RuntimeConfig;
  limiter?: RateLimiter;
  /** Navigate + observe only; abort if the entry screen is not this capability. */
  probe?: boolean;
  overlayTrace?: OverlayTrace;
};
