import { describe, expect, it } from "vitest";
import { canonicalizePath, canonicalizeUrl, expandLocator, expandParams } from "../src/artifact/canonical.ts";

describe("URL canonicalization", () => {
  it("turns /member/12345 into /member/:memberId", () => {
    expect(canonicalizePath("/member/12345", { memberId: "12345" })).toBe("/member/:memberId");
    expect(canonicalizeUrl("http://127.0.0.1:3000/member/12345/disputes", { memberId: "12345" })).toBe(
      "http://127.0.0.1:3000/member/:memberId/disputes",
    );
  });

  it("expands :memberId from inputs and leaves ports alone", () => {
    expect(expandParams("/member/:memberId", { memberId: "12345" })).toBe("/member/12345");
    expect(expandParams("http://127.0.0.1:3000/member/:memberId", { memberId: "67890" })).toBe(
      "http://127.0.0.1:3000/member/67890",
    );
  });

  it("expands :merchant in a row-scoped locator", () => {
    const expanded = expandLocator(
      {
        by: "role",
        role: "link",
        name: "Open",
        scope: { by: "row", hasText: [":merchant", ":last4"] },
      },
      { merchant: "ACME POS", last4: "4412" },
    );
    expect(expanded.scope && expanded.scope.by === "row" ? expanded.scope.hasText : []).toEqual(["ACME POS", "4412"]);
  });

  it("expands {{parameters.disputeId}} on a cellInRow locator", () => {
    const locator = expandLocator(
      {
        by: "cellInRow",
        row: { matches: "{{parameters.disputeId}}" },
        cell: "Amount",
      },
      { disputeId: "DSP-1001" },
    );
    expect(locator.row?.matches).toBe("DSP-1001");
    expect(expandParams("cell {{parameters.disputeId}}", { disputeId: "DSP-1001" })).toBe("cell DSP-1001");
  });
});
