/**
 * Typed failures the CLI and tests can switch on by `code` / `instanceof`.
 * Do not parse `error.message` to decide what happened.
 */
export class RelayError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class CapabilityNotFoundError extends RelayError {
  readonly idOrPath: string;
  readonly path: string;

  constructor(idOrPath: string, path: string, cause?: unknown) {
    super(
      "CAPABILITY_NOT_FOUND",
      `Cannot load capability ${JSON.stringify(idOrPath)} from ${path}. Discover with --id first, then replay --capability capabilities/<id>.json.`,
      cause !== undefined ? { cause } : undefined,
    );
    this.idOrPath = idOrPath;
    this.path = path;
  }
}

export class ArtifactSchemaError extends RelayError {
  constructor(message: string, cause?: unknown) {
    super("ARTIFACT_SCHEMA", message, cause !== undefined ? { cause } : undefined);
  }
}

export class CliUsageError extends RelayError {
  constructor(message: string) {
    super("CLI_USAGE", message);
  }
}

export class UnsupportedSqlError extends RelayError {
  constructor(message: string) {
    super("UNSUPPORTED_SQL", message);
  }
}

export class DuplicateFilingError extends RelayError {
  readonly disputeId: string;

  constructor(disputeId: string) {
    super("DISPUTE_ALREADY_FILED", `Dispute ${disputeId} is already filed.`);
    this.disputeId = disputeId;
  }
}

export class InvalidCsrfError extends RelayError {
  constructor(message = "Form token missing or expired.") {
    super("INVALID_CSRF", message);
  }
}

export class MethodNotAllowedError extends RelayError {
  constructor(method: string, path: string) {
    super("METHOD_NOT_ALLOWED", `${method} ${path} is not allowed. Irreversible actions require POST.`);
  }
}

export class ApprovalError extends RelayError {
  constructor(code: "APPROVAL_REQUIRED" | "TWO_PERSON_RULE" | "REVIEW_FAILED", message: string) {
    super(code, message);
  }
}

export class RateLimitError extends RelayError {
  constructor(message: string) {
    super("RATE_LIMIT", message);
  }
}

export class InterventionTransitionError extends RelayError {
  constructor(message: string) {
    super("ILLEGAL_TRANSITION", message);
  }
}

export class MissingApiKeyError extends RelayError {
  constructor(envName: string) {
    super("MISSING_API_KEY", `${envName} is required for live discovery.`);
  }
}

export class LlmError extends RelayError {
  constructor(message: string) {
    super("LLM_ERROR", message);
  }
}

export class PolicyConfigError extends RelayError {
  constructor(message: string, cause?: unknown) {
    super("POLICY_CONFIG", message, cause !== undefined ? { cause } : undefined);
  }
}

export class OverlayConflictError extends RelayError {
  constructor(message: string, cause?: unknown) {
    super("OVERLAY_CONFLICT", message, cause !== undefined ? { cause } : undefined);
  }
}

export type ErrorPayload = {
  ok: false;
  error: { code: string; name: string; message: string };
};

export function errorPayload(err: unknown): ErrorPayload {
  if (err instanceof RelayError) {
    return { ok: false, error: { code: err.code, name: err.name, message: err.message } };
  }
  if (err instanceof Error) {
    const code = "code" in err && typeof err.code === "string" ? err.code : "UNCAUGHT";
    return { ok: false, error: { code, name: err.name, message: err.message } };
  }
  return { ok: false, error: { code: "UNCAUGHT", name: "Error", message: String(err) } };
}
