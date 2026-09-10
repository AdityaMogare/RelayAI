import type { Capability, OutputDef } from "../core/types.ts";

const SECRET_KEYS = /password|passwd|secret|token|ssn|credential|authorization/i;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const ACCOUNT = /\b(?:ACCT|acc(?:ount)?)[- ]?\d{4,}\b/g;
const LONG_DIGIT = /\b\d{9,}\b/g;
const BEARER = /Bearer\s+[A-Za-z0-9._-]+/g;

const DROP_KEYS = new Set(["aria", "text", "observationPreview"]);

export type RedactionContext = {
  piiFields: Set<string>;
  piiValues: string[];
};

export function contextFromCapability(capability: Capability): RedactionContext {
  const piiFields = new Set<string>(
    capability.outputs.filter((o) => outputIsPii(o)).map((o) => o.name),
  );
  return { piiFields, piiValues: [] };
}

export function outputIsPii(output: OutputDef): boolean {
  if (output.pii === true) return true;
  if (output.type === "money") return true;
  return /balance|amount|name|ssn|account/i.test(output.name);
}

/** Regex backstop for secrets. Misses names ("Jane Doe") and money ("$4,250.00"). */
export function redactText(value: string): string {
  return value
    .replace(SSN, "[REDACTED-SSN]")
    .replace(ACCOUNT, "[REDACTED-ACCOUNT]")
    .replace(BEARER, "Bearer [REDACTED]")
    .replace(LONG_DIGIT, "[REDACTED-NUMBER]");
}

function isMoneyShape(value: unknown): value is { currency: unknown; minor: unknown } {
  return Boolean(value && typeof value === "object" && "currency" in value && "minor" in value);
}

/** PII money keeps the contract visible: { currency: "USD", minor: "[REDACTED]" }. */
export function redactPiiField(value: unknown): unknown {
  if (isMoneyShape(value)) {
    return { currency: value.currency, minor: "[REDACTED]" };
  }
  return "[REDACTED-PII]";
}

export function redactValue(key: string, value: unknown, ctx?: RedactionContext): unknown {
  if (DROP_KEYS.has(key)) return undefined;
  if (SECRET_KEYS.test(key) && key !== "credentialRef") return "[REDACTED]";
  if (ctx?.piiFields.has(key)) return redactPiiField(value);
  if (typeof value === "string") return redactString(value, ctx);
  if (Array.isArray(value)) return value.map((item, i) => redactValue(String(i), item, ctx));
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    if (isMoneyShape(rec) && ctx?.piiFields.size) {
      return { currency: rec.currency, minor: "[REDACTED]" };
    }
    return Object.fromEntries(
      Object.entries(rec)
        .map(([k, v]) => [k, redactValue(k, v, ctx)])
        .filter(([, v]) => v !== undefined),
    );
  }
  return value;
}

function redactString(value: string, ctx?: RedactionContext): string {
  let out = redactText(value);
  if (!ctx) return out;
  for (const secret of ctx.piiValues) {
    if (secret && out.includes(secret)) out = out.split(secret).join("[REDACTED-PII]");
  }
  return out;
}

export function redactDeep<T>(value: T, ctx?: RedactionContext): T {
  return redactValue("root", value, ctx) as T;
}

export function looksSensitive(name: string): boolean {
  return SECRET_KEYS.test(name);
}

export function notePiiValue(ctx: RedactionContext, raw: string | undefined): void {
  if (!raw) return;
  const trimmed = raw.trim();
  if (trimmed.length < 2) return;
  if (!ctx.piiValues.includes(trimmed)) ctx.piiValues.push(trimmed);
}
