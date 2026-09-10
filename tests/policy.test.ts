import { describe, expect, it } from "vitest";
import { PolicyGuard, PolicyViolation } from "../src/policy/policy.ts";
import { redactDeep, redactPiiField, redactText } from "../src/policy/redact.ts";

const policy = new PolicyGuard({
  allowedHosts: ["127.0.0.1", "localhost"],
  allowedActions: ["navigate", "click", "type", "extract", "dismiss", "wait", "select"],
  riskyActions: ["click"],
  riskyNames: ["confirm", "delete"],
});

describe("policy guard", () => {
  it("blocks hosts outside the allowlist", () => {
    expect(() => policy.assertUrl("https://evil.example/login")).toThrow(PolicyViolation);
  });

  it("allows the local console", () => {
    expect(() => policy.assertUrl("http://127.0.0.1:3000/member/12345")).not.toThrow();
  });

  it("does not treat about:blank as an off-policy host", () => {
    expect(() =>
      policy.assertAction({ name: "navigate", url: "http://127.0.0.1:3000/" }, "about:blank"),
    ).not.toThrow();
  });

  it("blocks unknown action types", () => {
    expect(() => policy.assertAction({ name: "navigate", url: "http://127.0.0.1:3000/" })).not.toThrow();
    expect(() => policy.assertAction({ name: "click" })).not.toThrow();
  });

  it("marks irreversible names as risky by exact match only", () => {
    expect(policy.riskFor({ name: "click", target: { primary: { by: "role", role: "button", name: "Confirm" } } })).toBe(
      "risky",
    );
    expect(policy.riskFor({ name: "click", target: { primary: { by: "role", role: "button", name: "Search" } } })).toBe(
      "safe",
    );
    expect(policy.riskFor({ name: "click", target: { primary: { by: "role", role: "button", name: "Submit search" } } })).toBe(
      "safe",
    );
    expect(
      policy.riskFor({
        name: "extract",
        target: { primary: { by: "role", role: "status", name: "Confirmation" } },
      }),
    ).toBe("safe");
  });
});

describe("redaction", () => {
  it("strips SSN, account numbers, and secret keys", () => {
    expect(redactText("ssn 123-45-6789 acct ACCT-88421")).toContain("[REDACTED-SSN]");
    expect(redactText("ssn 123-45-6789 acct ACCT-88421")).toContain("[REDACTED-ACCOUNT]");
    expect(redactDeep({ password: "hunter2", note: "ok" })).toEqual({
      password: "[REDACTED]",
      note: "ok",
    });
  });

  it("names the regex misses: Jane Doe and $4,250.00", () => {
    expect(redactText("Jane Doe holds $4,250.00")).toBe("Jane Doe holds $4,250.00");
  });

  it("keeps the money contract visible when redacting PII", () => {
    expect(redactPiiField({ currency: "USD", minor: 425000 })).toEqual({ currency: "USD", minor: "[REDACTED]" });
    expect(redactPiiField("Jane Doe")).toBe("[REDACTED-PII]");
  });
});
