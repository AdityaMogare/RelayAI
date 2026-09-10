import { describe, expect, it } from "vitest";
import { LOOKUP_MEMBER_SAVINGS, VERIFY_AND_FILE_DISPUTE } from "./fixtures.ts";
import { doubleRunFingerprints } from "../src/replay/roundtrip.ts";

describe("double-run determinism", () => {
  it("byte-compares normalized traces for the same lookup artifact", async () => {
    const { a, b, resultA, resultB } = await doubleRunFingerprints(LOOKUP_MEMBER_SAVINGS, {
      memberId: "12345",
    });
    expect(resultA.status).toBe("success");
    expect(resultB.status).toBe("success");
    expect(resultA.outputs).toEqual(resultB.outputs);
    expect(resultA.locatorHits?.map((h) => ({ stepId: h.stepId, rank: h.rank, by: h.by }))).toEqual(
      resultB.locatorHits?.map((h) => ({ stepId: h.stepId, rank: h.rank, by: h.by })),
    );
    expect(a).toBe(b);
  });

  it("byte-compares normalized traces for a filed dispute", async () => {
    const { a, b, resultA } = await doubleRunFingerprints(
      VERIFY_AND_FILE_DISPUTE,
      { memberId: "12345", merchant: "ACME POS", last4: "4412", reason: "Unauthorized" },
      { approveRisky: true },
    );
    expect(resultA.status).toBe("success");
    expect(a).toBe(b);
  });
});
