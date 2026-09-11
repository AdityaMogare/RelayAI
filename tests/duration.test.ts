import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { countDiscovers, parseJsonl, wallClockUntil } from "../src/evidence/duration.ts";

describe("discovery duration", () => {
  it("stops at discover.end and ignores a later hash-stamp", () => {
    const events = parseJsonl(`{"at":"2026-09-10T05:12:30.346Z","kind":"discover.start"}
{"at":"2026-09-10T05:12:31.000Z","kind":"discover.decide","data":{"model":"gpt-4o"}}
{"at":"2026-09-10T05:12:47.136Z","kind":"discover.end"}
{"at":"2026-09-11T18:16:32.000Z","kind":"discover.artifact","data":{"contentHash":"abc"}}
`);
    const counted = countDiscovers(events);
    expect(counted.durationMs).toBe(16_790);
    expect(counted.calls).toBe(1);
    expect(counted.model).toBe("gpt-4o");
    expect(wallClockUntil(events, "discover.end")).toBeLessThan(60_000);
  });

  it("does not use the last log line when discover.end is missing", () => {
    const events = parseJsonl(`{"at":"2026-09-10T05:12:30.346Z","kind":"discover.start"}
{"at":"2026-09-11T18:16:32.000Z","kind":"discover.artifact"}
`);
    expect(countDiscovers(events).durationMs).toBe(0);
  });

  it("reads the committed verify-and-file-dispute log as ~16.8s, not hours", () => {
    const raw = readFileSync(resolve("evidence/discovery-verify-and-file-dispute/log.jsonl"), "utf8");
    const counted = countDiscovers(parseJsonl(raw));
    expect(counted.calls).toBe(13);
    expect(counted.model).toBe("gpt-4o");
    expect(counted.durationMs).toBe(16_790);
  });
});
