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

export type LocatorBy = "role" | "label" | "text" | "css";

export type Locator = {
  by: LocatorBy;
  role?: string;
  name?: string;
  text?: string;
  selector?: string;
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
};

export type ExceptionClass = "business_outcome" | "recoverable" | "hard_failure";

export type ExceptionDetect = {
  textIncludes?: string;
  dialogTitle?: string;
  urlIncludes?: string;
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
  note?: string;
};

export type Capability = {
  schemaVersion: "1.0";
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
  steps: ArtifactStep[];
  exceptionalStates: ExceptionalState[];
  success: { checkpoint: Checkpoint };
};

export type RunStatus = "success" | "business_outcome" | "escalated" | "failed";

export type RunResult = {
  status: RunStatus;
  outputs?: Record<string, string>;
  code?: string;
  message?: string;
  stepId?: string;
  expected?: string;
  observed?: string;
  interventionId?: string;
  evidencePath?: string;
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
};

export type EvidenceEvent = {
  at: string;
  runId: string;
  kind: string;
  data: Record<string, unknown>;
};
