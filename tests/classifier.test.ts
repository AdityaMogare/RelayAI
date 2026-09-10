import { describe, expect, it } from "vitest";
import { checkpointHolds } from "../src/replay/checkpoints.ts";
import { matchException, matchesDetect } from "../src/replay/classifier.ts";
import { LOOKUP_MEMBER_SAVINGS } from "./fixtures.ts";
import type { Observation } from "../src/core/types.ts";

const obs = (partial: Partial<Observation>): Observation => ({
  url: "http://127.0.0.1:3000/",
  title: "Relay Credit Union",
  text: "",
  aria: "",
  refs: [],
  ...partial,
});

describe("exception classifier", () => {
  it("matches not-found from page text", () => {
    const hit = matchException(
      LOOKUP_MEMBER_SAVINGS,
      obs({ text: "Member not found", url: "http://127.0.0.1:3000/search" }),
    );
    expect(hit?.code).toBe("MEMBER_NOT_FOUND");
    expect(hit?.classify).toBe("business_outcome");
  });

  it("matches a dialog title for recoverable interstitials", () => {
    const notice = LOOKUP_MEMBER_SAVINGS.exceptionalStates.find((s) => s.code === "SYSTEM_NOTICE")!;
    expect(matchesDetect(notice, obs({ dialog: "System Notice" }))).toBe(true);
    expect(matchesDetect(notice, obs({ dialog: "Other" }))).toBe(false);
  });
});

describe("checkpoints", () => {
  it("expands :memberId in urlIncludes", () => {
    expect(
      checkpointHolds(
        { kind: "urlIncludes", expect: "/member/:memberId" },
        obs({ url: "http://127.0.0.1:3000/member/12345" }),
        { memberId: "12345" },
      ),
    ).toBe(true);
  });
});
