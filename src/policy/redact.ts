const SECRET_KEYS = /password|passwd|secret|token|ssn|credential|authorization/i;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const ACCOUNT = /\b(?:ACCT|acc(?:ount)?)[- ]?\d{4,}\b/gi;
const LONG_DIGIT = /\b\d{9,}\b/g;
const BEARER = /Bearer\s+[A-Za-z0-9._-]+/g;

export function redactText(value: string): string {
  return value
    .replace(SSN, "[REDACTED-SSN]")
    .replace(ACCOUNT, "[REDACTED-ACCOUNT]")
    .replace(BEARER, "Bearer [REDACTED]")
    .replace(LONG_DIGIT, "[REDACTED-NUMBER]");
}

export function redactValue(key: string, value: unknown): unknown {
  if (SECRET_KEYS.test(key)) return "[REDACTED]";
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((item, i) => redactValue(String(i), item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactValue(k, v)]),
    );
  }
  return value;
}

export function redactDeep<T>(value: T): T {
  return redactValue("root", value) as T;
}

export function looksSensitive(name: string): boolean {
  return SECRET_KEYS.test(name);
}
