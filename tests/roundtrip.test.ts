import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { scriptedRoundTrip } from "../src/replay/roundtrip.ts";

describe("discover → compile → replay round-trip", () => {
  it("replays the compiled artifact and proves the hashes match", async () => {
    const proof = await scriptedRoundTrip();
    expect(proof.result.status).toBe("success");
    expect(proof.result.outputs.savingsBalance).toEqual({ currency: "USD", minor: 425000 });
    expect(proof.discoverHash).toBe(proof.replayHash);
    expect(proof.matched).toBe(true);

    const discoverLog = readFileSync(proof.discoverLog, "utf8");
    const replayLog = readFileSync(proof.replayLog, "utf8");
    expect(discoverLog).toContain(`"contentHash":"${proof.discoverHash}"`);
    expect(replayLog).toContain(`"contentHash":"${proof.replayHash}"`);
    expect(discoverLog).toContain("discover.end");
    expect(replayLog).toContain("replay.start");
  });
});
