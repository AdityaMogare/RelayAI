import { describe, expect, it } from "vitest";
import { driftScore } from "../src/replay/drift.ts";
import type { LedgerEntry } from "../src/replay/ledger.ts";

function row(partial: Partial<LedgerEntry>): LedgerEntry {
  return {
    at: "2026-09-10T00:00:00.000Z",
    capabilityId: "lookup-member-savings",
    idempotencyKey: "k",
    status: "success",
    runId: "r",
    tenantId: "tenant-9",
    fallbackHits: 0,
    targetedHits: 3,
    checkpointMiss: false,
    ...partial,
  };
}

describe("per-tenant drift score", () => {
  it("stays quiet when rank-1 hits hold", () => {
    const report = driftScore([row({}), row({ runId: "r2" }), row({ runId: "r3" })], { tenantId: "tenant-9" });
    expect(report.needsRediscovery).toBe(false);
    expect(report.fallbackLocatorRate).toBe(0);
    expect(report.checkpointMissRate).toBe(0);
  });

  it("flags rediscovery from fallback-locator rate + checkpoint misses", () => {
    const report = driftScore(
      [
        row({ fallbackHits: 2, targetedHits: 3, needsRediscovery: true }),
        row({ status: "failed", checkpointMiss: true, code: "CHECKPOINT_FAILED", targetedHits: 1, fallbackHits: 0 }),
        row({ fallbackHits: 3, targetedHits: 3, needsRediscovery: true }),
      ],
      { tenantId: "tenant-9", window: 20 },
    );
    expect(report.needsRediscovery).toBe(true);
    expect(report.fallbackLocatorRate).toBeGreaterThan(0.15);
    expect(report.reason).toMatch(/Re-discover/);
  });

  it("ignores other tenants", () => {
    const report = driftScore([row({ tenantId: "tenant-14", fallbackHits: 3, targetedHits: 3 })], {
      tenantId: "tenant-9",
    });
    expect(report.runs).toBe(0);
    expect(report.needsRediscovery).toBe(false);
  });
});
