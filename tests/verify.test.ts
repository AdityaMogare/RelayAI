import { describe, expect, it } from "vitest";
import { runVerify } from "../src/verify.ts";

describe("verify matrix", () => {
  it("covers every scenario and stays green", async () => {
    const report = await runVerify();
    const failed = report.rows.filter((row) => !row.ok);
    expect(failed, failed.map((row) => `${row.scenario}: expected ${row.expected} got ${row.got}`).join("; ")).toEqual(
      [],
    );
    expect(report.ok).toBe(true);
    expect(report.rows.some((row) => row.scenario === "round-trip discover→replay")).toBe(true);
    expect(report.rows.some((row) => row.scenario === "determinism double-run")).toBe(true);
  });
});
