import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LOOKUP_MEMBER_SAVINGS, OPEN_SUB_ACCOUNT } from "./fixtures.ts";
import { approveCapability, reviewCapability } from "../src/artifact/review.ts";
import { ApprovalError } from "../src/core/errors.ts";
import { EvidenceStore } from "../src/evidence/store.ts";
import { purgeEvidence } from "../src/evidence/purge.ts";
import { queryAudit, type LedgerEntry } from "../src/replay/ledger.ts";
import { ReplayEngine } from "../src/replay/engine.ts";
import { PolicyGuard, PolicyViolation } from "../src/policy/policy.ts";
import { matchPath } from "../src/policy/routes.ts";
import { MemoryInvocationStore, RateLimiter } from "../src/policy/runtime.ts";
import { MemoryVault } from "../src/policy/vault.ts";
import { MockSurface } from "../src/surfaces/mock.ts";
import type { Capability } from "../src/core/types.ts";

function harness() {
  const surface = new MockSurface();
  const evidence = new EvidenceStore(`test-${Math.random().toString(16).slice(2)}`, mkdtempSync(join(tmpdir(), "relay-")));
  const engine = new ReplayEngine(surface, evidence);
  return { surface, evidence, engine };
}

describe("route-level allowlist", () => {
  const policy = new PolicyGuard();

  it("allows POST submit/confirm and rejects GET on those paths", () => {
    expect(() =>
      policy.assertRequest("POST", "http://127.0.0.1:3000/member/12345/disputes/DSP-1001/submit"),
    ).not.toThrow();
    expect(() => policy.assertRequest("POST", "http://127.0.0.1:3000/admin/wire")).toThrow(PolicyViolation);
    expect(() => policy.assertRequest("GET", "http://127.0.0.1:3000/admin/wire")).toThrow(PolicyViolation);
    expect(() =>
      policy.assertRequest("GET", "http://127.0.0.1:3000/member/12345/disputes/DSP-1001/submit"),
    ).toThrow(PolicyViolation);
    expect(() =>
      policy.assertRequest("GET", "http://127.0.0.1:3000/member/12345/sub-account/confirm"),
    ).toThrow(PolicyViolation);
    expect(() =>
      policy.assertRequest("GET", "http://127.0.0.1:3000/member/12345/sub-account/opened"),
    ).not.toThrow();
    expect(() =>
      policy.assertRequest("GET", "http://127.0.0.1:3000/member/12345/disputes/DSP-1001/receipt"),
    ).not.toThrow();
  });

  it("answers could this agent ever reach the wire-transfer screen with a flat no", () => {
    expect(policy.couldReach("/admin/wire")).toBe(false);
    expect(policy.couldReach("/member/12345")).toBe(true);
    expect(matchPath("/admin/**", "/admin/wire")).toBe(true);
  });
});

describe("risk is a reviewed artifact property", () => {
  it("does not treat Submit search as risky at proposal time", () => {
    const policy = new PolicyGuard();
    expect(
      policy.proposeRisk({
        name: "click",
        target: { primary: { by: "role", role: "button", name: "Submit search" } },
      }),
    ).toBe("safe");
    expect(
      policy.proposeRisk({
        name: "click",
        target: { primary: { by: "role", role: "button", name: "Post payment" } },
      }),
    ).toBe("safe");
    expect(
      policy.proposeRisk({
        name: "click",
        target: { primary: { by: "role", role: "button", name: "Confirm" } },
      }),
    ).toBe("risky");
  });

  it("replays a Submit-search step as safe because the artifact says so, not the runtime", async () => {
    const { engine } = harness();
    const cap: Capability = {
      ...LOOKUP_MEMBER_SAVINGS,
      steps: LOOKUP_MEMBER_SAVINGS.steps.map((step) =>
        step.id === "s02-click"
          ? {
              ...step,
              target: {
                primary: { by: "role", role: "button", name: "Search" },
                fallbacks: step.target?.fallbacks,
              },
              risk: "safe",
            }
          : step,
      ),
    };
    const result = await engine.run(cap, { inputs: { memberId: "12345" } });
    expect(result.status).toBe("success");
  });

  it("catches Confirm marked safe at the approval gate / diff, not at runtime", () => {
    const poisoned: Capability = {
      ...OPEN_SUB_ACCOUNT,
      steps: OPEN_SUB_ACCOUNT.steps.map((step) => (step.id === "s06-confirm" ? { ...step, risk: "safe" } : step)),
    };
    const findings = reviewCapability(poisoned);
    expect(findings.some((f) => f.stepId === "s06-confirm")).toBe(true);
    expect(() =>
      approveCapability(poisoned, { requestedBy: "analyst@relay", approvedBy: "risk@relay" }),
    ).toThrow(ApprovalError);
  });

  it("rejects same-person approval for irreversible work", () => {
    expect(() =>
      approveCapability(OPEN_SUB_ACCOUNT, { requestedBy: "alex@relay", approvedBy: "alex@relay" }),
    ).toThrow(ApprovalError);
  });

  it("blocks replay of a risky capability with no two-person stamp", async () => {
    const { engine } = harness();
    const unsigned = { ...OPEN_SUB_ACCOUNT, approval: undefined };
    const result = await engine.run(unsigned, {
      inputs: { memberId: "12345", product: "Share Savings" },
      approveRisky: true,
    });
    expect(result.status).toBe("failed");
    expect(result.code).toBe("APPROVAL_REQUIRED");
  });
});

describe("credentials, PII, blast radius, kill switch, audit, retention", () => {
  it("resolves vault:// refs at replay and never writes the secret", async () => {
    const { engine, evidence } = harness();
    const vault = new MemoryVault({
      "vault://tenant-9/teller": { username: "teller01", secret: "super-secret-token-xyz" },
    });
    const result = await engine.run(LOOKUP_MEMBER_SAVINGS, {
      inputs: { memberId: "12345" },
      vault,
    });
    expect(result.status).toBe("success");
    const dump = readFileSync(join(evidence.dir, "log.jsonl"), "utf8") + readFileSync(join(evidence.dir, "result.json"), "utf8");
    expect(dump).toContain("[REDACTED]");
    expect(dump).not.toContain("super-secret-token-xyz");
  });

  it("redacts classified PII outputs and does not persist Jane Doe or $4,250.00", async () => {
    const { engine, evidence } = harness();
    const result = await engine.run(LOOKUP_MEMBER_SAVINGS, { inputs: { memberId: "12345" } });
    expect(result.status).toBe("success");
    expect(result.outputs.savingsBalance).toEqual({ currency: "USD", minor: 425000 });
    const dump = readFileSync(join(evidence.dir, "log.jsonl"), "utf8") + readFileSync(join(evidence.dir, "result.json"), "utf8");
    expect(dump).not.toContain("Jane Doe");
    expect(dump).not.toContain("$4,250.00");
    expect(dump).toContain('"currency": "USD"');
    expect(dump).toContain('"[REDACTED]"');
    expect(dump).not.toMatch(/savingsBalance": "\[REDACTED-PII\]"/);
  });

  it("enforces per-capability per-tenant hourly limits", async () => {
    const { engine } = harness();
    const limiter = new RateLimiter(new MemoryInvocationStore(), {
      maxInvocationsPerCapabilityPerHour: 1,
      maxInvocationsPerTenantPerHour: 10,
    });
    const first = await engine.run(LOOKUP_MEMBER_SAVINGS, { inputs: { memberId: "12345" }, limiter, tenantId: "tenant-9" });
    expect(first.status).toBe("success");
    const second = await engine.run(LOOKUP_MEMBER_SAVINGS, { inputs: { memberId: "12345" }, limiter, tenantId: "tenant-9" });
    expect(second.status).toBe("failed");
    expect(second.code).toBe("RATE_LIMIT");
  });

  it("kills a capability without a deploy", async () => {
    const { engine } = harness();
    const result = await engine.run(LOOKUP_MEMBER_SAVINGS, {
      inputs: { memberId: "12345" },
      runtime: {
        disabled: { capabilities: ["lookup-member-savings"], tenants: [] },
        blastRadius: { maxInvocationsPerCapabilityPerHour: 30, maxInvocationsPerTenantPerHour: 120 },
        retention: { ttlDays: 14 },
      },
    });
    expect(result.status).toBe("failed");
    expect(result.code).toBe("KILL_SWITCH");
  });

  it("answers the regulator from the audit ledger", () => {
    const tuesday = "2026-09-08T16:00:00.000Z";
    const entries: LedgerEntry[] = [
      {
        at: tuesday,
        capabilityId: "lookup-member-savings",
        idempotencyKey: "k",
        status: "success",
        runId: "r1",
        tenantId: "tenant-9",
        memberId: "12345",
        routes: ["/", "/search", "/member/12345"],
        credentialRef: "vault://tenant-9/teller",
      },
    ];
    const hits = queryAudit(entries, {
      memberId: "12345",
      from: "2026-09-08T00:00:00.000Z",
      to: "2026-09-09T00:00:00.000Z",
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.routes).toContain("/member/12345");
  });

  it("purges evidence older than 14 days", () => {
    const root = mkdtempSync(join(tmpdir(), "relay-ev-"));
    const oldDir = join(root, "old-run");
    mkdirSync(oldDir);
    writeFileSync(join(oldDir, "log.jsonl"), "{}\n");
    const ancient = Date.now() - 20 * 24 * 3600_000;
    utimesSync(oldDir, ancient / 1000, ancient / 1000);
    const result = purgeEvidence(root, Date.now());
    expect(result.ttlDays).toBe(14);
    expect(result.deleted).toContain("old-run");
  });
});
