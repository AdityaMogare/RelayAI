import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCapability } from "../src/artifact/schema.ts";
import { FileArtifactStore, MemoryArtifactStore } from "../src/artifact/store.ts";
import { ArtifactSchemaError, CapabilityNotFoundError } from "../src/core/errors.ts";
import { UnsupportedSchemaError } from "../src/artifact/migrate.ts";
import { LOOKUP_MEMBER_SAVINGS, VERIFY_AND_FILE_DISPUTE } from "./fixtures.ts";

describe("artifact schema", () => {
  it("accepts the golden lookup capability from disk", () => {
    const parsed = parseCapability(LOOKUP_MEMBER_SAVINGS);
    expect(parsed.id).toBe("lookup-member-savings");
    expect(parsed.parameters[0]?.name).toBe("memberId");
    expect(parsed.success.checkpoint.expect).toBe("Savings Balance");
  });

  it("accepts the verify-and-file-dispute capability from disk", () => {
    const parsed = parseCapability(VERIFY_AND_FILE_DISPUTE);
    expect(parsed.id).toBe("verify-and-file-dispute");
    expect(parsed.parameters.map((p) => p.name)).toEqual(["memberId", "merchant", "last4", "reason"]);
    expect(parsed.steps.some((s) => s.id === "s10-confirm" && s.risk === "risky")).toBe(true);
    expect(parsed.exceptionalStates.some((s) => s.code === "DISPUTE_NOT_FOUND")).toBe(true);
    expect(parsed.uses).toEqual([{ capabilityId: "lookup-member-savings", pass: ["memberId"] }]);
    expect(parsed.sideEffects.kind).toBe("irreversible");
    expect(parsed.provenance.discoveredBy).toBe("model");
    expect(parsed.steps.every((s) => s.timeoutMs === 8000 && s.retryBudget === 3)).toBe(true);
    expect(parsed.steps.some((s) => s.action === "navigate")).toBe(false);
  });

  it("rejects a missing success checkpoint with ArtifactSchemaError", () => {
    expect(() => parseCapability({ ...LOOKUP_MEMBER_SAVINGS, success: {} })).toThrow(ArtifactSchemaError);
  });

  it("round-trips through the file-shaped store", async () => {
    const store = new MemoryArtifactStore();
    await store.save(LOOKUP_MEMBER_SAVINGS);
    const loaded = await store.load("lookup-member-savings");
    expect(loaded.outputs[0]?.name).toBe("savingsBalance");
  });

  it("fails loudly when the capability file is missing", async () => {
    const store = new FileArtifactStore(mkdtempSync(join(tmpdir(), "relay-caps-")));
    await expect(store.load("no-such-capability")).rejects.toThrow(CapabilityNotFoundError);
    try {
      await store.load("no-such-capability");
      throw new Error("expected CapabilityNotFoundError");
    } catch (err) {
      expect(err).toBeInstanceOf(CapabilityNotFoundError);
      if (err instanceof CapabilityNotFoundError) {
        expect(err.code).toBe("CAPABILITY_NOT_FOUND");
        expect(err.idOrPath).toBe("no-such-capability");
      }
    }
  });

  it("migrates a 1.0 artifact to 1.1 so it still loads", () => {
    const v10 = {
      schemaVersion: "1.0",
      id: "legacy-lookup",
      name: "Legacy Lookup",
      description: "Read a member.",
      version: 1,
      app: { vendorId: "relay-core", surfaceKind: "legacy-web" },
      parameters: [{ name: "memberId", type: "string" }],
      outputs: [
        {
          name: "savingsBalance",
          type: "money",
          locator: { primary: { by: "role", role: "cell", name: "Savings Balance" } },
        },
      ],
      steps: [
        {
          id: "s00-navigate",
          action: "navigate",
          url: "http://127.0.0.1:3000/",
          risk: "safe",
          checkpoint: { kind: "textIncludes", expect: "Member Lookup" },
        },
      ],
      exceptionalStates: [],
      success: { checkpoint: { kind: "textIncludes", expect: "Savings Balance" } },
    };
    const parsed = parseCapability(v10);
    expect(parsed.schemaVersion).toBe("1.1");
    expect(parsed.sideEffects.kind).toBe("none");
    expect(parsed.preconditions.requiresRole).toBe("teller");
    expect(parsed.uses).toEqual([]);
    expect(parsed.provenance.discoveredBy).toBe("human");
    expect(parsed.steps[0]?.timeoutMs).toBe(8000);
    expect(parsed.steps[0]?.retryBudget).toBe(3);
  });

  it("refuses schema 2.0 instead of guessing", () => {
    expect(() => parseCapability({ schemaVersion: "2.0", id: "future" })).toThrow(UnsupportedSchemaError);
    try {
      parseCapability({ schemaVersion: "2.0", id: "future" });
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedSchemaError);
      if (err instanceof UnsupportedSchemaError) expect(err.code).toBe("UNSUPPORTED_SCHEMA");
    }
  });

  it("cold-reads the lookup contract: blast radius, entry, return, author", () => {
    const parsed = parseCapability(LOOKUP_MEMBER_SAVINGS);
    expect(parsed.sideEffects.kind).toBe("none");
    expect(parsed.sideEffects.compensation).toMatch(/only reads/i);
    expect(parsed.preconditions.entryCheckpoint.expect).toBe("Member Lookup");
    expect(parsed.outputs[0]?.name).toBe("savingsBalance");
    expect(parsed.provenance.model).toBe("gpt-4o");
    expect(parsed.provenance.promptHash).toHaveLength(64);
  });
});
