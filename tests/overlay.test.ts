import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOOKUP_MEMBER_SAVINGS, OPEN_SUB_ACCOUNT } from "./fixtures.ts";
import { OverlayConflictError } from "../src/core/errors.ts";
import { parseOverlay } from "../src/overlay/schema.ts";
import { describeConfirmFix, resolveCapability } from "../src/overlay/resolve.ts";
import { bindTenant } from "../src/overlay/store.ts";
import { EvidenceStore } from "../src/evidence/store.ts";
import { ReplayEngine } from "../src/replay/engine.ts";
import { parseMoney } from "../src/replay/outputs.ts";
import { probeApplicability } from "../src/replay/probe.ts";
import { formatPortability, runPortability } from "../src/replay/portability.ts";
import { MockSurface } from "../src/surfaces/mock.ts";

const CU_WEST = { Search: "Find Member", "Member Lookup": "Find a Member", Confirm: "Submit Request" };

describe("overlay resolution", () => {
  it("applies tenant-14 copy and keeps Confirm risky", () => {
    const bound = bindTenant(OPEN_SUB_ACCOUNT, "tenant-14");
    const confirm = bound.capability.steps.find((step) => step.id === "s06-confirm");
    expect(confirm?.target?.primary.name).toBe("Submit Request");
    expect(confirm?.risk).toBe("risky");
    expect(bound.capability.sideEffects.kind).toBe("irreversible");
    expect(bound.trace.copy.Confirm).toBe("Submit Request");
    const fix = describeConfirmFix(bound.trace);
    expect(fix?.file).toBe("overlays/tenants/tenant-14.yaml");
    expect(fix?.who).toMatch(/tenant ops/i);
  });

  it("rejects an overlay that tries to change risk", () => {
    expect(() => parseOverlay({ kind: "tenant", id: "x", vendorId: "relay-core", risk: "safe" })).toThrow(
      OverlayConflictError,
    );
    expect(() =>
      parseOverlay({ kind: "tenant", id: "x", vendorId: "relay-core", steps: [] }),
    ).toThrow(OverlayConflictError);
  });

  it("rejects a tenant overlay bound to the wrong vendor", () => {
    expect(() =>
      resolveCapability(LOOKUP_MEMBER_SAVINGS, {
        tenant: { kind: "tenant", id: "t", vendorId: "other-core", copy: { Search: "Go" } },
      }),
    ).toThrow(OverlayConflictError);
  });

  it("replays the recorded lookup against CU West copy via the overlay", async () => {
    const bound = bindTenant(LOOKUP_MEMBER_SAVINGS, "tenant-14");
    const surface = new MockSurface("search", CU_WEST);
    const evidence = new EvidenceStore("overlay-lookup", mkdtempSync(join(tmpdir(), "relay-overlay-")));
    const result = await new ReplayEngine(surface, evidence).run(bound.capability, {
      inputs: { memberId: "12345" },
      tenantId: "tenant-14",
      overlayTrace: bound.trace,
    });
    expect(result.status).toBe("success");
    expect(result.needsRediscovery).toBe(false);
    expect(result.outputs.savingsBalance).toEqual(parseMoney("$4,250.00"));
    expect(result.locatorHits?.every((hit) => hit.rank === 1)).toBe(true);
  });

  it("opens a sub-account on CU West with Confirm remapped, risk unchanged", async () => {
    const bound = bindTenant(OPEN_SUB_ACCOUNT, "tenant-14");
    const surface = new MockSurface("search", CU_WEST);
    const evidence = new EvidenceStore("overlay-confirm", mkdtempSync(join(tmpdir(), "relay-overlay-")));
    const result = await new ReplayEngine(surface, evidence).run(bound.capability, {
      inputs: { memberId: "12345", product: "Share Savings" },
      tenantId: "tenant-14",
      overlayTrace: bound.trace,
      approveRisky: true,
    });
    expect(result.status).toBe("success");
    expect(bound.capability.steps.find((s) => s.id === "s06-confirm")?.risk).toBe("risky");
  });

  it("misses Search on CU West without an overlay", async () => {
    const surface = new MockSurface("search", CU_WEST);
    const evidence = new EvidenceStore("overlay-miss", mkdtempSync(join(tmpdir(), "relay-overlay-")));
    const result = await new ReplayEngine(surface, evidence).run(LOOKUP_MEMBER_SAVINGS, {
      inputs: { memberId: "12345" },
      probe: true,
    });
    expect(result.status).toBe("failed");
    expect(result.code).toBe("NOT_APPLICABLE");
  });
});

describe("applicability probe", () => {
  it("passes when overlay copy matches the skin", async () => {
    const bound = bindTenant(LOOKUP_MEMBER_SAVINGS, "tenant-14");
    const probe = await probeApplicability(new MockSurface("search", CU_WEST), bound.capability, {
      inputs: { memberId: "12345" },
    });
    expect(probe.applicable).toBe(true);
    expect(probe.locators.some((item) => item.name === "Find Member" && item.present)).toBe(true);
  });

  it("refuses a mis-bound artifact before any click", async () => {
    const probe = await probeApplicability(new MockSurface("search", CU_WEST), LOOKUP_MEMBER_SAVINGS);
    expect(probe.applicable).toBe(false);
    expect(probe.entryCheckpoint.held).toBe(false);
  });
});

describe("portability report", () => {
  it("runs one artifact against tenant-9 and tenant-14", async () => {
    const report = await runPortability({
      capability: LOOKUP_MEMBER_SAVINGS,
      tenants: [
        {
          tenantId: "tenant-9",
          resolved: bindTenant(LOOKUP_MEMBER_SAVINGS, "tenant-9"),
          surface: new MockSurface(),
          inputs: { memberId: "12345" },
        },
        {
          tenantId: "tenant-14",
          resolved: bindTenant(LOOKUP_MEMBER_SAVINGS, "tenant-14"),
          surface: new MockSurface("search", CU_WEST),
          inputs: { memberId: "12345" },
        },
      ],
    });
    expect(report.tenants).toHaveLength(2);
    expect(report.tenants.every((t) => t.result.status === "success")).toBe(true);
    expect(report.tenants[1]?.copy.Search).toBe("Find Member");
    expect(report.tenants[1]?.fellBack).toEqual([]);
    expect(formatPortability(report)).toContain("Find Member");
  });
});

describe("westside overlay", () => {
  const WEST = {
    Search: "Find Member",
    "Member Lookup": "Find a Member",
    Disputes: "Card Claims",
    Confirm: "Submit Request",
  };

  it("replays the recorded lookup against westside copy via the overlay", async () => {
    const bound = bindTenant(LOOKUP_MEMBER_SAVINGS, "westside");
    const surface = new MockSurface("search", WEST);
    const evidence = new EvidenceStore("overlay-westside", mkdtempSync(join(tmpdir(), "relay-westside-")));
    const result = await new ReplayEngine(surface, evidence).run(bound.capability, {
      inputs: { memberId: "12345" },
      tenantId: "westside",
      overlayTrace: bound.trace,
    });
    expect(result.status).toBe("success");
    expect(result.needsRediscovery).toBe(false);
    expect(bound.trace.copy.Search).toBe("Find Member");
    expect(bound.capability.exceptionalStates.some((s) => s.code === "BRANCH_VERIFICATION")).toBe(true);
  });
});
