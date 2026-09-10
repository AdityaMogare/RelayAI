import { describe, expect, it } from "vitest";
import { UnsupportedSchemaError } from "../src/artifact/migrate.ts";
import {
  CapabilityNotFoundError,
  CliUsageError,
  errorPayload,
  OverlayConflictError,
  PolicyConfigError,
  RelayError,
} from "../src/core/errors.ts";
import { loadPolicy } from "../src/policy/policy.ts";

describe("typed errors", () => {
  it("exposes a stable code instead of requiring message matching", () => {
    const err = new CapabilityNotFoundError("lookup-x", "/tmp/lookup-x.json");
    expect(err).toBeInstanceOf(RelayError);
    expect(err.code).toBe("CAPABILITY_NOT_FOUND");
    expect(errorPayload(err)).toEqual({
      ok: false,
      error: { code: "CAPABILITY_NOT_FOUND", name: "CapabilityNotFoundError", message: err.message },
    });
  });

  it("wraps unknown throws as UNCAUGHT", () => {
    expect(errorPayload(new Error("boom"))).toEqual({
      ok: false,
      error: { code: "UNCAUGHT", name: "Error", message: "boom" },
    });
    expect(errorPayload("nope").error.code).toBe("UNCAUGHT");
  });

  it("keeps UnsupportedSchemaError and CliUsageError switchable by class", () => {
    expect(new UnsupportedSchemaError("nope")).toBeInstanceOf(RelayError);
    expect(new CliUsageError("bad flag").code).toBe("CLI_USAGE");
  });

  it("rejects overlay files that try to change risk or steps", () => {
    const err = new OverlayConflictError("nope");
    expect(err).toBeInstanceOf(RelayError);
    expect(err.code).toBe("OVERLAY_CONFLICT");
  });

  it("fails loudly when the allowlist file is missing", () => {
    expect(() => loadPolicy("/no/such/allowlist.yaml")).toThrow(PolicyConfigError);
  });
});
