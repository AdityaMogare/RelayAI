export type SurfaceKind = "web" | "legacy-web" | "desktop";

export type ControlOwner = "automation" | "human";

export type ActionName =
  | "navigate"
  | "click"
  | "type"
  | "select"
  | "extract"
  | "dismiss"
  | "wait";

export type RiskClass = "safe" | "risky";

export type LocatorBy = "role" | "label" | "text" | "css" | "cellInRow";

/**
 * Scope a control before resolving it.
 * - `row`: the table row whose cells include `hasText` (replay expands :params / {{parameters.x}}).
 * - `region`: a named panel/fieldset (MDI workspaces with duplicate control names).
 */
export type LocatorScope =
  | { by: "row"; hasText: string[] }
  | { by: "region"; heading: string };

export type Locator = {
  by: LocatorBy;
  role?: string;
  name?: string;
  text?: string;
  selector?: string;
  scope?: LocatorScope;
  /** cellInRow: which row, expanded from parameters at replay. */
  row?: { matches: string };
  /** cellInRow: column header or control name inside that row. */
  cell?: string;
};

export type Target = {
  primary: Locator;
  fallbacks?: Locator[];
};

export type Action = {
  name: ActionName;
  target?: Target;
  value?: string;
  url?: string;
  outputName?: string;
  timeoutMs?: number;
  idempotencyKey?: string;
};

export type InteractiveRef = {
  ref: string;
  role: string;
  name: string;
};

export type Observation = {
  url: string;
  title: string;
  aria: string;
  text: string;
  refs: InteractiveRef[];
  dialog?: string;
};

export type ActionResult = {
  ok: boolean;
  extracted?: string;
  error?: string;
  usedLocator?: Locator;
  /** HTTP 5xx / timeout — retry with backoff. Locator misses are not retryable. */
  retryable?: boolean;
  /** Table row the control lived in — compiler turns this into a scoped locator. */
  row?: { headers: string[]; cells: string[] };
};

export type ExceptionClass =
  | "business_outcome"
  | "recoverable"
  | "transient"
  | "hard_failure"
  | "needs_human";

export type ExceptionDetect = {
  textIncludes?: string;
  dialogTitle?: string;
  urlIncludes?: string;
  /** True: this detector fires on a locator miss, not on an observation. */
  locatorMiss?: boolean;
};

export type RecoverAction = {
  action: "dismiss" | "wait";
  target?: Target;
  ms?: number;
};

export type ExceptionalState = {
  detect: ExceptionDetect;
  classify: ExceptionClass;
  code: string;
  message: string;
  recoverAction?: RecoverAction;
};

export type Checkpoint = {
  kind: "urlIncludes" | "textIncludes" | "titleIncludes";
  expect: string;
};

export type ParamDef = {
  name: string;
  type: "string" | "number";
  description?: string;
  sensitive?: boolean;
};

export type OutputDef = {
  name: string;
  type: "string" | "money";
  description?: string;
  locator: Target;
  /** Structural PII flag. Evidence redacts this field by name, not by regex. */
  pii?: boolean;
};

export type CapabilityAuth = {
  /** vault://tenant/role — resolved at replay; never a password literal. */
  credentialRef: string;
};

export type CapabilityApproval = {
  requestedBy: string;
  approvedBy: string;
  approvedAt: string;
};

export type ArtifactStep = {
  id: string;
  action: ActionName;
  target?: Target;
  value?: string;
  inputFrom?: string;
  url?: string;
  outputName?: string;
  risk: RiskClass;
  checkpoint?: Checkpoint;
  /** If this holds after an observation, replay is on the wrong screen. Never retry. */
  antiCheckpoints?: Checkpoint[];
  note?: string;
  timeoutMs: number;
  retryBudget: number;
  /** Operator id if a human performed this step during discovery. */
  assistedBy?: string;
};

export type SideEffectKind = "none" | "creates" | "mutates" | "irreversible";

export type SideEffects = {
  kind: SideEffectKind;
  /** What a human does to undo this. Declared on the capability, not in step notes. */
  compensation: string;
};

export type Preconditions = {
  requiresSession: boolean;
  requiresRole?: string;
  entryCheckpoint: Checkpoint;
};

export type CapabilityUse = {
  capabilityId: string;
  /** Parameter names forwarded to the used capability. */
  pass: string[];
};

export type Provenance = {
  discoveredAt: string;
  discoveredBy: "model" | "human";
  model?: string;
  promptHash?: string;
  evidenceRunId?: string;
  /** Original natural-language goal. Re-discovery uses this, not the description slug. */
  goal?: string;
  /** Operator who unblocked a stuck discovery step. */
  assistedBy?: string;
};

export type SessionContext = {
  authenticated: boolean;
  role?: string;
};

export type Capability = {
  schemaVersion: "1.1";
  id: string;
  name: string;
  description: string;
  version: number;
  app: {
    vendorId: string;
    surfaceKind: SurfaceKind;
  };
  parameters: ParamDef[];
  outputs: OutputDef[];
  auth?: CapabilityAuth;
  approval?: CapabilityApproval;
  sideEffects: SideEffects;
  preconditions: Preconditions;
  uses: CapabilityUse[];
  provenance: Provenance;
  /** Parameter names that uniquely identify one mutating execution. */
  idempotencyKeyFrom?: string[];
  steps: ArtifactStep[];
  exceptionalStates: ExceptionalState[];
  /** Vendor-level "you are lost" screens. Cheaper than only asserting positives. */
  antiCheckpoints?: Checkpoint[];
  success: { checkpoint: Checkpoint };
};

export type MoneyValue = {
  currency: string;
  minor: number;
};

export type OutputValue = string | MoneyValue;

export type InputViolation = {
  path: string;
  expected: string;
  observed: string;
};

export type RunStatus =
  | "success"
  | "business_outcome"
  | "escalated"
  | "failed"
  | "needs_human"
  | "invalid_input"
  | "dry_run";

/** Which locator in the ranked chain actually matched. Rank 1 is primary. */
export type LocatorHit = {
  stepId: string;
  rank: number;
  by: LocatorBy;
  locator: Locator;
};

export type WouldExecuteStep = {
  stepId: string;
  action: ActionName;
  risk: RiskClass;
  target?: Locator;
  note?: string;
};

export type RunResult = {
  status: RunStatus;
  outputs: Record<string, OutputValue>;
  code?: string;
  classify?: ExceptionClass;
  message?: string;
  stepId?: string;
  expected?: string;
  observed?: string;
  interventionId?: string;
  evidencePath?: string;
  locatorHits?: LocatorHit[];
  /** True when any step matched below rank 1 — re-discover, do not treat success as healthy. */
  needsRediscovery?: boolean;
  /** Fraction of targeted steps that matched rank 1. */
  confidence?: number;
  wouldExecute?: WouldExecuteStep[];
  violations?: InputViolation[];
  /** True when an irreversible act returned ok but the checkpoint did not hold. */
  ambiguous?: boolean;
  idempotencyKey?: string;
  metrics?: RunMetrics;
};

export type RunMetrics = {
  durationMs: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

export type InterventionState =
  | "raised"
  | "claimed"
  | "in_control"
  | "returned"
  | "resolved"
  | "abandoned";

export type StepDisposition = "completed_by_human" | "not_done" | "abort";

/** How the operator path was driven. Scripted waiters must not read as a teller. */
export type OperatorKind = "human" | "scripted";

export type InterventionTransition = {
  state: InterventionState;
  at: string;
  operatorId?: string;
  note?: string;
};

export type InterventionRequest = {
  id: string;
  createdAt: string;
  reason: string;
  goal?: string;
  capabilityId?: string;
  stepId?: string;
  url?: string;
  screenshotPath?: string;
  observationPreview?: string;
  checkpointExpect?: string;
  sessionId?: string;
  state?: InterventionState;
  operatorId?: string;
  transitions?: InterventionTransition[];
  ttlMs?: number;
  expiresAt?: string;
  claimedAt?: string;
  inControlAt?: string;
  returnedAt?: string;
  resolvedAt?: string;
  abandonedAt?: string;
  stepDisposition?: StepDisposition;
  /** Page the run paused on — re-asserted after resume before executing. */
  entryCheckpoint?: Checkpoint;
  queuePriority?: number;
  /**
   * `scripted` = auto-resume / humanCompletesRiskyStep.
   * `human` = operator console claim/return. Timestamps plus this field are the tell.
   */
  operatorKind?: OperatorKind;
};

export type EvidenceEvent = {
  at: string;
  runId: string;
  kind: string;
  data: Record<string, unknown>;
};
