import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LOOKUP_MEMBER_SAVINGS } from "../src/artifact/compile.ts";
import { EvidenceStore } from "../src/evidence/store.ts";
import { ReplayEngine } from "../src/replay/engine.ts";
import { runStability } from "../src/replay/stability.ts";
import { MockSurface } from "../src/surfaces/mock.ts";

describe("replay stability", () => {
  it("reports a perfect rate when every mock run succeeds", async () => {
    const surface = new MockSurface();
    const report = await runStability({
      surface,
      capability: LOOKUP_MEMBER_SAVINGS,
      inputs: { memberId: "12345" },
      runs: 3,
    });
    expect(report.runs).toBe(3);
    expect(report.success).toBe(3);
    expect(report.failed).toBe(0);
    expect(report.rate).toBe(1);
  });

  it("counts locator misses as failed runs", async () => {
    const surface = new MockSurface();
    surface.failNextLocator = true;
    const evidence = new EvidenceStore("stability-fail", mkdtempSync(join(tmpdir(), "relay-")));
    const once = await new ReplayEngine(surface, evidence).run(LOOKUP_MEMBER_SAVINGS, {
      inputs: { memberId: "12345" },
    });
    expect(once.status).toBe("failed");
  });
});
