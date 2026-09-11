import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startConsole, type ConsoleServer } from "../apps/bank-console/server.ts";
import { BLOCK_AND_REISSUE_CARD } from "./fixtures.ts";
import { ControlPlane, immediateResume } from "../src/escalation/control.ts";
import { EvidenceStore } from "../src/evidence/store.ts";
import { MemoryInvocationStore, RateLimiter, loadRuntime } from "../src/policy/runtime.ts";
import { MemoryRunLedger } from "../src/replay/ledger.ts";
import { ReplayEngine } from "../src/replay/engine.ts";
import type { ReplayOptions } from "../src/replay/options.ts";
import { WebSurface } from "../src/surfaces/web.ts";

const CARD_SQL = "SELECT count(*) FROM card_actions WHERE member_id='12345' AND last4='4412'";
const OK = { memberId: "12345", last4: "4412" };

describe("block-and-reissue-card against the live console", () => {
  let consoleServer: ConsoleServer;

  beforeAll(async () => {
    consoleServer = await startConsole(0);
  });

  afterAll(async () => {
    await consoleServer.close();
  });

  beforeEach(() => {
    consoleServer.reset();
  });

  async function run(inputs: Record<string, string>, extra: Omit<ReplayOptions, "inputs" | "baseUrl"> = {}) {
    const surface = new WebSurface();
    await surface.launch();
    const evidence = new EvidenceStore(`card-${Math.random().toString(16).slice(2)}`, mkdtempSync(join(tmpdir(), "relay-card-")));
    try {
      return await new ReplayEngine(surface, evidence).run(BLOCK_AND_REISSUE_CARD, {
        inputs,
        baseUrl: consoleServer.origin,
        ...extra,
      });
    } finally {
      await surface.close();
    }
  }

  it("block + reissue returns a CASE-88 case number", async () => {
    const result = await run(OK, { approveRisky: true });
    expect(result.status).toBe("success");
    expect(String(result.outputs.confirmation)).toMatch(/CASE-88\d+/);
    expect(consoleServer.cardActions.exec(CARD_SQL).count).toBe(1);
  });

  it("already-blocked 7788 is a business_outcome, not a failure", async () => {
    const result = await run({ memberId: "12345", last4: "7788" }, { approveRisky: true });
    expect(result.status).toBe("business_outcome");
    expect(result.code).toBe("CARD_ALREADY_BLOCKED");
    expect(consoleServer.cardActions.exec("SELECT count(*) FROM card_actions WHERE member_id='12345' AND last4='7788'").count).toBe(0);
  });

  it("business-account 3301 is needs_human without a ControlPlane", async () => {
    const result = await run({ memberId: "12345", last4: "3301" }, { approveRisky: true });
    expect(result.status).toBe("needs_human");
    expect(result.code).toBe("SUPERVISOR_REQUIRED");
    expect(consoleServer.cardActions.exec("SELECT count(*) FROM card_actions WHERE member_id='12345' AND last4='3301'").count).toBe(0);
  });

  it("business-account 3301 escalates when a ControlPlane is wired", async () => {
    const surface = new WebSurface();
    await surface.launch();
    const evidence = new EvidenceStore("card-3301-esc", mkdtempSync(join(tmpdir(), "relay-card-")));
    const control = new ControlPlane(surface, evidence, immediateResume("auto-resume"));
    try {
      const result = await new ReplayEngine(surface, evidence).run(BLOCK_AND_REISSUE_CARD, {
        inputs: { memberId: "12345", last4: "3301" },
        baseUrl: consoleServer.origin,
        control,
      });
      expect(result.status).toBe("escalated");
      expect(result.code).toBe("SUPERVISOR_REQUIRED");
      expect(result.interventionId).toBeDefined();
      expect(control.lastIntervention).toBeTruthy();
    } finally {
      await surface.close();
    }
  });

  it("ledger-free second invoke leaves sqlite count at 1", async () => {
    const first = await run(OK, { approveRisky: true });
    expect(first.status).toBe("success");
    const second = await run(OK, { approveRisky: true });
    expect(second.status).toBe("business_outcome");
    expect(second.code).toBe("CARD_ALREADY_BLOCKED");
    expect(consoleServer.cardActions.exec(CARD_SQL).count).toBe(1);
  });

  it("ledger blocks a second mutating invoke even with --approve-risky", async () => {
    const ledger = new MemoryRunLedger();
    const first = await run(OK, { approveRisky: true, ledger });
    expect(first.status).toBe("success");
    const second = await run(OK, { approveRisky: true, ledger });
    expect(second.status).toBe("failed");
    expect(second.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(consoleServer.cardActions.exec(CARD_SQL).count).toBe(1);
  });

  it("the 31st invoke against the 30/hr cap is RATE_LIMIT and does not write", async () => {
    const store = new MemoryInvocationStore();
    const limiter = new RateLimiter(store, loadRuntime().blastRadius);
    for (let i = 0; i < 30; i += 1) limiter.assert("tenant-9", "block-and-reissue-card");
    const result = await run(OK, { approveRisky: true, limiter, tenantId: "tenant-9" });
    expect(result.status).toBe("failed");
    expect(result.code).toBe("RATE_LIMIT");
    expect(consoleServer.cardActions.exec(CARD_SQL).count).toBe(0);
  });
});
