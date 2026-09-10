import { describe, expect, it } from "vitest";
import { coerceOutput, parseMoney } from "../src/replay/outputs.ts";
import { rankedTarget } from "../src/artifact/ranked.ts";

describe("money parser", () => {
  it("parses a USD display string into minor units", () => {
    expect(parseMoney("$4,250.00")).toEqual({ currency: "USD", minor: 425000 });
    expect(parseMoney("$42.18")).toEqual({ currency: "USD", minor: 4218 });
    expect(parseMoney("($10.00)")).toEqual({ currency: "USD", minor: -1000 });
  });

  it("rejects empty and non-money strings", () => {
    expect(parseMoney("")).toBeUndefined();
    expect(parseMoney("Transaction Amount")).toBeUndefined();
    expect(parseMoney("—")).toBeUndefined();
  });

  it("coerces a declared money output or returns the schema violation", () => {
    const def = { name: "transactionAmount", type: "money" as const, locator: rankedTarget("cell", "Transaction Amount") };
    expect(coerceOutput(def, "$42.18")).toEqual({ ok: true, value: { currency: "USD", minor: 4218 } });
    expect(coerceOutput(def, "")).toEqual({
      ok: false,
      expected: "transactionAmount: money { currency, minor }",
      observed: "(empty)",
    });
  });
});
