import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LOOKUP_MEMBER_SAVINGS } from "./fixtures.ts";
import { EvidenceStore } from "../src/evidence/store.ts";
import { ReplayEngine } from "../src/replay/engine.ts";
import { parseMoney } from "../src/replay/outputs.ts";
import { DesktopSurface } from "../src/surfaces/desktop.ts";

function harness(start?: ConstructorParameters<typeof DesktopSurface>[0]) {
  const surface = new DesktopSurface(start);
  const evidence = new EvidenceStore(`desktop-${Math.random().toString(16).slice(2)}`, mkdtempSync(join(tmpdir(), "relay-desktop-")));
  return { surface, engine: new ReplayEngine(surface, evidence) };
}

describe("desktop surface (fake accessibility tree)", () => {
  it("replays lookup success against the a11y tree, not Playwright", async () => {
    const { engine } = harness();
    const result = await engine.run(LOOKUP_MEMBER_SAVINGS, { inputs: { memberId: "12345" } });
    expect(result.status).toBe("success");
    expect(result.outputs.savingsBalance).toEqual(parseMoney("$4,250.00"));
    expect(result.needsRediscovery).toBe(false);
  });

  it("classifies not-found and denied the same as the web adapter", async () => {
    const missing = await harness().engine.run(LOOKUP_MEMBER_SAVINGS, { inputs: { memberId: "99999" } });
    expect(missing.status).toBe("business_outcome");
    expect(missing.code).toBe("MEMBER_NOT_FOUND");
    const denied = await harness().engine.run(LOOKUP_MEMBER_SAVINGS, { inputs: { memberId: "55555" } });
    expect(denied.status).toBe("business_outcome");
    expect(denied.code).toBe("PERMISSION_DENIED");
  });

  it("dismisses a notice and continues", async () => {
    const { engine } = harness("notice");
    const result = await engine.run(LOOKUP_MEMBER_SAVINGS, { inputs: { memberId: "12345" } });
    expect(result.status).toBe("success");
  });

  it("stops on session expiry as needs_human", async () => {
    const result = await harness().engine.run(LOOKUP_MEMBER_SAVINGS, { inputs: { memberId: "00000" } });
    expect(result.status).toBe("needs_human");
    expect(result.code).toBe("SESSION_EXPIRED");
  });
});
