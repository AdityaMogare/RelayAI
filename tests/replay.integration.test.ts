import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startConsole, type ConsoleServer } from "../apps/bank-console/server.ts";
import { LOOKUP_MEMBER_SAVINGS, VERIFY_AND_FILE_DISPUTE } from "../src/artifact/compile.ts";
import { EvidenceStore } from "../src/evidence/store.ts";
import { ReplayEngine } from "../src/replay/engine.ts";
import { WebSurface } from "../src/surfaces/web.ts";

describe("playwright replay against the local console", () => {
  let consoleServer: ConsoleServer;

  beforeAll(async () => {
    consoleServer = await startConsole(0);
  });

  afterAll(async () => {
    await consoleServer.close();
  });

  it("extracts a real savings balance", async () => {
    const surface = new WebSurface();
    await surface.launch();
    const evidence = new EvidenceStore("it-success", mkdtempSync(join(tmpdir(), "relay-")));
    try {
      const result = await new ReplayEngine(surface, evidence).run(LOOKUP_MEMBER_SAVINGS, {
        inputs: { memberId: "12345" },
        baseUrl: consoleServer.origin,
      });
      expect(result.status).toBe("success");
      expect(result.outputs?.savingsBalance).toBe("$4,250.00");
    } finally {
      await surface.close();
    }
  });

  it("classifies an unknown member as a business outcome", async () => {
    const surface = new WebSurface();
    await surface.launch();
    const evidence = new EvidenceStore("it-notfound", mkdtempSync(join(tmpdir(), "relay-")));
    try {
      const result = await new ReplayEngine(surface, evidence).run(LOOKUP_MEMBER_SAVINGS, {
        inputs: { memberId: "99999" },
        baseUrl: consoleServer.origin,
      });
      expect(result.status).toBe("business_outcome");
      expect(result.code).toBe("MEMBER_NOT_FOUND");
    } finally {
      await surface.close();
    }
  });

  it("files a seeded dispute and returns a confirmation", async () => {
    const surface = new WebSurface();
    await surface.launch();
    const evidence = new EvidenceStore("it-dispute", mkdtempSync(join(tmpdir(), "relay-")));
    try {
      const result = await new ReplayEngine(surface, evidence).run(VERIFY_AND_FILE_DISPUTE, {
        inputs: { memberId: "12345", disputeId: "DSP-1001", reason: "Unauthorized" },
        baseUrl: consoleServer.origin,
        approveRisky: true,
      });
      expect(result.status).toBe("success");
      expect(result.outputs?.transactionAmount).toBe("$42.18");
      expect(result.outputs?.confirmation).toContain("CASE-77201");
    } finally {
      await surface.close();
    }
  });

  it("classifies an unknown dispute as a business outcome", async () => {
    const surface = new WebSurface();
    await surface.launch();
    const evidence = new EvidenceStore("it-dispute-missing", mkdtempSync(join(tmpdir(), "relay-")));
    try {
      const result = await new ReplayEngine(surface, evidence).run(VERIFY_AND_FILE_DISPUTE, {
        inputs: { memberId: "12345", disputeId: "DSP-9999", reason: "Unauthorized" },
        baseUrl: consoleServer.origin,
        approveRisky: true,
      });
      expect(result.status).toBe("business_outcome");
      expect(result.code).toBe("DISPUTE_NOT_FOUND");
    } finally {
      await surface.close();
    }
  });

  it("extracts a table value even when the locator hits the rowheader", async () => {
    const surface = new WebSurface();
    await surface.launch();
    try {
      await surface.act({ name: "navigate", url: `${consoleServer.origin}/member/12345` });
      const result = await surface.act({
        name: "extract",
        target: { primary: { by: "role", role: "rowheader", name: "Savings Balance" } },
        outputName: "savingsBalance",
      });
      expect(result.ok).toBe(true);
      expect(result.extracted).toBe("$4,250.00");
    } finally {
      await surface.close();
    }
  });
});
