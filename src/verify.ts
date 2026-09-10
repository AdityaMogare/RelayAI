import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCapabilityFile } from "./artifact/store.ts";
import type { Capability, OutputValue, RunResult, RunStatus } from "./core/types.ts";
import { ControlPlane, immediateResume } from "./escalation/control.ts";
import { EvidenceStore } from "./evidence/store.ts";
import { ReplayEngine } from "./replay/engine.ts";
import { parseMoney } from "./replay/outputs.ts";
import { REPLAY_NON_DETERMINISM } from "./replay/normalize.ts";
import { doubleRunFingerprints, scriptedRoundTrip } from "./replay/roundtrip.ts";
import { bindTenant } from "./overlay/store.ts";
import { probeApplicability } from "./replay/probe.ts";
import { driftScore } from "./replay/drift.ts";
import { DesktopSurface } from "./surfaces/desktop.ts";
import { MockSurface } from "./surfaces/mock.ts";

export type VerifyRow = {
  scenario: string;
  expected: string;
  got: string;
  proof: string;
  ok: boolean;
};

export type VerifyReport = {
  rows: VerifyRow[];
  ok: boolean;
  passed: number;
  failed: number;
  text: string;
};

type Expectation = {
  status: RunStatus;
  code?: string;
  outputs?: Record<string, OutputValue>;
  needsRediscovery?: boolean;
  wouldExecuteStep?: string;
};

async function replay(
  capability: Capability,
  inputs: Record<string, string>,
  extra: {
    approveRisky?: boolean;
    dryRun?: boolean;
    resume?: boolean;
    skipPrimary?: boolean;
    failWhenName?: string;
    start?: ConstructorParameters<typeof MockSurface>[0];
    labels?: Record<string, string>;
    tenant?: string;
    probe?: boolean;
    desktop?: boolean;
  } = {},
): Promise<RunResult> {
  const bound = extra.tenant ? bindTenant(capability, extra.tenant) : undefined;
  const resolved = bound?.capability ?? capability;
  const surface = extra.desktop
    ? new DesktopSurface(extra.start === "notice" ? "notice" : "search")
    : new MockSurface(extra.start, extra.labels);
  if (surface instanceof MockSurface || surface instanceof DesktopSurface) {
    surface.skipPrimary = Boolean(extra.skipPrimary);
    surface.failWhenName = extra.failWhenName;
  }
  const evidence = new EvidenceStore(`verify-${resolved.id}`, mkdtempSync(join(tmpdir(), "relay-verify-")));
  const control = extra.resume ? new ControlPlane(surface, evidence, immediateResume("verify-resume")) : undefined;
  return new ReplayEngine(surface, evidence).run(resolved, {
    inputs,
    approveRisky: extra.approveRisky,
    dryRun: extra.dryRun,
    control,
    tenantId: extra.tenant,
    probe: extra.probe,
    overlayTrace: bound?.trace,
  });
}

function check(result: RunResult, expectation: Expectation): { ok: boolean; got: string; proof: string } {
  const parts: string[] = [result.status];
  if (result.code) parts.push(result.code);
  const got = parts.join(" ");
  const expectedBits: string[] = [expectation.status];
  if (expectation.code) expectedBits.push(expectation.code);
  let ok = result.status === expectation.status;
  if (expectation.code) ok = ok && result.code === expectation.code;
  if (expectation.outputs) {
    for (const [key, value] of Object.entries(expectation.outputs)) {
      ok = ok && JSON.stringify(result.outputs[key]) === JSON.stringify(value);
    }
  }
  if (expectation.needsRediscovery !== undefined) {
    ok = ok && result.needsRediscovery === expectation.needsRediscovery;
  }
  if (expectation.wouldExecuteStep) {
    ok = ok && Boolean(result.wouldExecute?.some((step) => step.stepId === expectation.wouldExecuteStep));
  }
  const locators =
    result.locatorHits?.length && result.locatorHits.every((hit) => hit.rank === 1)
      ? "locators rank-1"
      : result.needsRediscovery
        ? `fallback rank ${result.locatorHits?.find((hit) => hit.rank > 1)?.rank ?? "?"} conf=${result.confidence?.toFixed(2)}`
        : result.locatorHits?.length
          ? "locators recorded"
          : "no locators";
  const outputs = Object.keys(result.outputs).length ? `outputs ${JSON.stringify(result.outputs)}` : "outputs {}";
  return { ok, got, proof: `${locators}; ${outputs}` };
}

function row(scenario: string, expected: string, got: string, proof: string, ok: boolean): VerifyRow {
  return { scenario, expected, got, proof, ok };
}

export async function runVerify(): Promise<VerifyReport> {
  const LOOKUP_MEMBER_SAVINGS = readCapabilityFile("lookup-member-savings").capability;
  const OPEN_SUB_ACCOUNT = readCapabilityFile("open-sub-account").capability;
  const VERIFY_AND_FILE_DISPUTE = readCapabilityFile("verify-and-file-dispute").capability;
  const rows: VerifyRow[] = [];

  const cases: Array<{
    scenario: string;
    capability: Capability;
    inputs: Record<string, string>;
    extra?: Parameters<typeof replay>[2];
    expect: Expectation;
  }> = [
    {
      scenario: "lookup success",
      capability: LOOKUP_MEMBER_SAVINGS,
      inputs: { memberId: "12345" },
      expect: { status: "success", outputs: { savingsBalance: parseMoney("$4,250.00")! }, needsRediscovery: false },
    },
    {
      scenario: "lookup not-found",
      capability: LOOKUP_MEMBER_SAVINGS,
      inputs: { memberId: "99999" },
      expect: { status: "business_outcome", code: "MEMBER_NOT_FOUND" },
    },
    {
      scenario: "lookup permission-denied",
      capability: LOOKUP_MEMBER_SAVINGS,
      inputs: { memberId: "55555" },
      expect: { status: "business_outcome", code: "PERMISSION_DENIED" },
    },
    {
      scenario: "lookup session-expired",
      capability: LOOKUP_MEMBER_SAVINGS,
      inputs: { memberId: "00000" },
      expect: { status: "needs_human", code: "SESSION_EXPIRED" },
    },
    {
      scenario: "lookup invalid-input",
      capability: LOOKUP_MEMBER_SAVINGS,
      inputs: {},
      expect: { status: "invalid_input", code: "INVALID_INPUT" },
    },
    {
      scenario: "lookup interstitial",
      capability: LOOKUP_MEMBER_SAVINGS,
      inputs: { memberId: "12345" },
      extra: { start: "notice" },
      expect: { status: "success", outputs: { savingsBalance: parseMoney("$4,250.00")! } },
    },
    {
      scenario: "dispute success",
      capability: VERIFY_AND_FILE_DISPUTE,
      inputs: { memberId: "12345", merchant: "ACME POS", last4: "4412", reason: "Unauthorized" },
      extra: { approveRisky: true },
      expect: { status: "success", outputs: { transactionAmount: parseMoney("$42.18")! } },
    },
    {
      scenario: "dispute not-found",
      capability: VERIFY_AND_FILE_DISPUTE,
      inputs: { memberId: "12345", merchant: "NO-SUCH", last4: "0000", reason: "Unauthorized" },
      extra: { approveRisky: true },
      expect: { status: "business_outcome", code: "DISPUTE_NOT_FOUND" },
    },
    {
      scenario: "dispute already-filed",
      capability: VERIFY_AND_FILE_DISPUTE,
      inputs: { memberId: "12345", merchant: "NORTHSIDE FUEL", last4: "4412", reason: "Unauthorized" },
      extra: { approveRisky: true },
      expect: { status: "business_outcome", code: "DISPUTE_ALREADY_FILED" },
    },
    {
      scenario: "dispute dry-run",
      capability: VERIFY_AND_FILE_DISPUTE,
      inputs: { memberId: "12345", merchant: "ACME POS", last4: "4412", reason: "Unauthorized" },
      extra: { dryRun: true },
      expect: {
        status: "dry_run",
        outputs: { transactionAmount: parseMoney("$42.18")! },
        wouldExecuteStep: "s10-confirm",
      },
    },
    {
      scenario: "dispute partial-fail",
      capability: VERIFY_AND_FILE_DISPUTE,
      inputs: { memberId: "12345", merchant: "ACME POS", last4: "4412", reason: "Unauthorized" },
      extra: { approveRisky: true, failWhenName: "Confirm" },
      expect: { status: "failed", outputs: { transactionAmount: parseMoney("$42.18")! } },
    },
    {
      scenario: "sub-account blocked",
      capability: OPEN_SUB_ACCOUNT,
      inputs: { memberId: "12345", product: "Share Savings" },
      expect: { status: "escalated", code: "RISKY_ACTION_BLOCKED" },
    },
    {
      scenario: "sub-account dry-run",
      capability: OPEN_SUB_ACCOUNT,
      inputs: { memberId: "12345", product: "Share Savings" },
      extra: { dryRun: true },
      expect: { status: "dry_run", wouldExecuteStep: "s06-confirm" },
    },
    {
      scenario: "sub-account resume",
      capability: OPEN_SUB_ACCOUNT,
      inputs: { memberId: "12345", product: "Share Savings" },
      extra: { resume: true },
      expect: { status: "success" },
    },
    {
      scenario: "locator fallback flags drift",
      capability: LOOKUP_MEMBER_SAVINGS,
      inputs: { memberId: "12345" },
      extra: { skipPrimary: true },
      expect: { status: "success", needsRediscovery: true, outputs: { savingsBalance: parseMoney("$4,250.00")! } },
    },
    {
      scenario: "tenant-14 overlay lookup",
      capability: LOOKUP_MEMBER_SAVINGS,
      inputs: { memberId: "12345" },
      extra: {
        tenant: "tenant-14",
        labels: { Search: "Find Member", "Member Lookup": "Find a Member", Confirm: "Submit Request" },
      },
      expect: { status: "success", needsRediscovery: false, outputs: { savingsBalance: parseMoney("$4,250.00")! } },
    },
    {
      scenario: "westside overlay lookup",
      capability: LOOKUP_MEMBER_SAVINGS,
      inputs: { memberId: "12345" },
      extra: {
        tenant: "westside",
        labels: { Search: "Find Member", "Member Lookup": "Find a Member", Confirm: "Submit Request" },
      },
      expect: { status: "success", needsRediscovery: false, outputs: { savingsBalance: parseMoney("$4,250.00")! } },
    },
    {
      scenario: "probe blocks mis-bound tenant",
      capability: LOOKUP_MEMBER_SAVINGS,
      inputs: { memberId: "12345" },
      extra: {
        probe: true,
        labels: { Search: "Find Member", "Member Lookup": "Find a Member" },
      },
      expect: { status: "failed", code: "NOT_APPLICABLE" },
    },
    {
      scenario: "desktop surface lookup",
      capability: LOOKUP_MEMBER_SAVINGS,
      inputs: { memberId: "12345" },
      extra: { desktop: true },
      expect: { status: "success", outputs: { savingsBalance: parseMoney("$4,250.00")! } },
    },
  ];

  for (const item of cases) {
    const result = await replay(item.capability, item.inputs, item.extra);
    const checked = check(result, item.expect);
    const expected = [item.expect.status, item.expect.code].filter(Boolean).join(" ");
    rows.push(row(item.scenario, expected, checked.got, checked.proof, checked.ok));
  }

  const roundTrip = await scriptedRoundTrip();
  const hashOk =
    roundTrip.matched &&
    roundTrip.result.status === "success" &&
    JSON.stringify(roundTrip.result.outputs.savingsBalance) === JSON.stringify(parseMoney("$4,250.00"));
  rows.push(
    row(
      "round-trip discover→replay",
      "success + hash match",
      `${roundTrip.result.status} ${roundTrip.discoverHash.slice(0, 12)}==${roundTrip.replayHash.slice(0, 12)}`,
      `discover.end contentHash === replay.start contentHash (${roundTrip.discoverHash})`,
      hashOk,
    ),
  );

  const det = await doubleRunFingerprints(LOOKUP_MEMBER_SAVINGS, { memberId: "12345" });
  rows.push(
    row(
      "determinism double-run",
      "byte-equal traces",
      det.a === det.b ? "equal" : "differ",
      "normalized steps + locators + outputs",
      det.a === det.b && det.resultA.status === "success" && det.resultB.status === "success",
    ),
  );

  const west = bindTenant(LOOKUP_MEMBER_SAVINGS, "tenant-14");
  const probeOk = await probeApplicability(new MockSurface("search", west.trace.copy), west.capability, {
    inputs: { memberId: "12345" },
  });
  rows.push(
    row(
      "applicability probe tenant-14",
      "applicable",
      probeOk.applicable ? "applicable" : "not applicable",
      probeOk.reason,
      probeOk.applicable && probeOk.locators.every((item) => item.present),
    ),
  );

  const drift = driftScore(
    [
      {
        at: "2026-09-10T00:00:00.000Z",
        capabilityId: "lookup-member-savings",
        idempotencyKey: "a",
        status: "failed",
        runId: "r1",
        tenantId: "tenant-9",
        fallbackHits: 3,
        targetedHits: 3,
        checkpointMiss: true,
        needsRediscovery: true,
        code: "CHECKPOINT_FAILED",
      },
    ],
    { tenantId: "tenant-9", window: 20 },
  );
  rows.push(
    row(
      "tenant drift flags rediscovery",
      "needsRediscovery",
      drift.needsRediscovery ? "needsRediscovery" : "healthy",
      drift.reason,
      drift.needsRediscovery,
    ),
  );

  const passed = rows.filter((r) => r.ok).length;
  const failed = rows.length - passed;
  const text = renderTable(rows, passed, failed);
  return { rows, ok: failed === 0, passed, failed, text };
}

function renderTable(rows: VerifyRow[], passed: number, failed: number): string {
  const tty = Boolean(process.stdout.isTTY);
  const green = (s: string) => (tty ? `\x1b[32m${s}\x1b[0m` : s);
  const red = (s: string) => (tty ? `\x1b[31m${s}\x1b[0m` : s);
  const mark = (ok: boolean) => (ok ? green("PASS") : red("FAIL"));
  const col = (value: string, width: number) => (value.length > width ? `${value.slice(0, width - 1)}…` : value.padEnd(width));
  const header = `${col("scenario", 36)} ${col("expected", 42)} ${col("got", 42)} proof`;
  const line = "-".repeat(130);
  const body = rows
    .map((r) => `${mark(r.ok)} ${col(r.scenario, 36)} ${col(r.expected, 42)} ${col(r.got, 42)} ${r.proof}`)
    .join("\n");
  const footer = failed === 0 ? green(`${passed} passed, ${failed} failed`) : red(`${passed} passed, ${failed} failed`);
  const nondet = REPLAY_NON_DETERMINISM.map((item) => `  - ${item}`).join("\n");
  return `RelayAI verify\n${line}\n${header}\n${line}\n${body}\n${line}\n${footer}\n\nNon-deterministic in replay today:\n${nondet}\n`;
}
