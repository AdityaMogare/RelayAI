import { describe, expect, it } from "vitest";
import { compileArtifact, promoteHits, type RecordedStep } from "../src/artifact/compile.ts";
import { parseCapability } from "../src/artifact/schema.ts";
import type { Action, Observation } from "../src/core/types.ts";
import { LOOKUP_MEMBER_SAVINGS } from "./fixtures.ts";

function obs(partial: Partial<Observation> = {}): Observation {
  return {
    url: "http://127.0.0.1:3000/",
    title: "",
    aria: "",
    text: "",
    refs: [],
    ...partial,
  };
}

function recorded(partial: Omit<RecordedStep, "observationBefore" | "risk"> & Partial<Pick<RecordedStep, "observationBefore" | "risk">>): RecordedStep {
  return {
    observationBefore: obs(),
    risk: "safe",
    ...partial,
  };
}

describe("compiler", () => {
  it("parameterizes discovery values that appear in the goal", () => {
    const artifact = compileArtifact({
      goal: "Look up member 12345 and read their current savings balance",
      targetUrl: "http://127.0.0.1:3000/",
      outputs: { savingsBalance: "$4,250.00" },
      recorded: [
        recorded({
          action: {
            name: "type",
            target: { primary: { by: "role", role: "textbox", name: "Member ID" } },
            value: "12345",
          },
          usedLocatorName: "Member ID",
        }),
      ],
    });
    expect(artifact.parameters.map((p) => p.name)).toContain("memberId");
    expect(artifact.parameters.find((p) => p.name === "memberId")?.type).toBe("string");
    expect(artifact.steps.some((s) => s.inputFrom === "parameters.memberId")).toBe(true);
    expect(artifact.steps.every((s) => s.value !== "12345")).toBe(true);
    expect(artifact.success.checkpoint.expect).toBe("Savings Balance");
    expect(artifact.sideEffects.kind).toBe("none");
  });

  it("parameterizes typed values even when they are not in the goal", () => {
    const artifact = compileArtifact({
      goal: "Look up a member",
      targetUrl: "http://127.0.0.1:3000/",
      outputs: {},
      recorded: [
        recorded({
          action: {
            name: "type",
            target: { primary: { by: "role", role: "textbox", name: "Member ID" } },
            value: "Jane Doe",
          },
          usedLocatorName: "Member ID",
        }),
      ],
    });
    expect(artifact.parameters.map((p) => p.name)).toEqual(["memberId"]);
    expect(artifact.steps.some((s) => s.inputFrom === "parameters.memberId")).toBe(true);
    expect(artifact.steps.every((s) => s.value !== "Jane Doe")).toBe(true);
    expect(artifact.provenance.goal).toBe("Look up a member");
  });

  it("drops consecutive duplicate extracts from the compiled capability", () => {
    const extract: Action = {
      name: "extract",
      target: { primary: { by: "role", role: "cell", name: "Savings Balance" } },
      outputName: "savingsBalance",
    };
    const artifact = compileArtifact({
      goal: "Look up member 12345",
      targetUrl: "http://127.0.0.1:3000/",
      outputs: { savingsBalance: "$4,250.00" },
      recorded: [
        recorded({ action: extract, usedLocatorName: "Savings Balance" }),
        recorded({ action: extract, usedLocatorName: "Savings Balance" }),
      ],
    });
    expect(artifact.steps.filter((s) => s.action === "extract")).toHaveLength(1);
  });

  it("keeps consecutive extracts that target different outputs", () => {
    const artifact = compileArtifact({
      goal: "Look up member 12345",
      targetUrl: "http://127.0.0.1:3000/",
      outputs: { savingsBalance: "$4,250.00", memberName: "Jane Doe" },
      recorded: [
        recorded({
          action: {
            name: "extract",
            target: { primary: { by: "role", role: "cell", name: "Savings Balance" } },
            outputName: "savingsBalance",
          },
        }),
        recorded({
          action: {
            name: "extract",
            target: { primary: { by: "role", role: "cell", name: "Name" } },
            outputName: "memberName",
          },
        }),
      ],
    });
    expect(artifact.steps.filter((s) => s.action === "extract")).toHaveLength(2);
  });

  it("drops extract-of-a-button (model mis-click during discovery)", () => {
    const artifact = compileArtifact({
      goal: "File dispute DSP-1001",
      targetUrl: "http://127.0.0.1:3000/",
      outputs: { confirmation: "Dispute filed" },
      recorded: [
        recorded({
          action: {
            name: "extract",
            target: { primary: { by: "role", role: "button", name: "Confirm" } },
            outputName: "confirmation",
          },
        }),
        recorded({
          action: {
            name: "click",
            target: { primary: { by: "role", role: "button", name: "Confirm" } },
          },
          risk: "risky",
        }),
      ],
    });
    expect(artifact.steps.some((s) => s.action === "extract")).toBe(false);
    expect(artifact.steps.some((s) => s.action === "click" && s.risk === "risky")).toBe(true);
  });

  it("parameterizes quoted select values and attaches dispute exceptions", () => {
    const artifact = compileArtifact({
      goal: 'File dispute DSP-1001 for member 12345 with reason "Unauthorized"',
      targetUrl: "http://127.0.0.1:3000/",
      id: "verify-and-file-dispute",
      outputs: { confirmation: "Confirmation: Dispute DSP-1001 filed (Unauthorized). Case CASE-77201." },
      recorded: [
        recorded({
          action: {
            name: "type",
            target: { primary: { by: "role", role: "textbox", name: "Member ID" } },
            value: "12345",
          },
          usedLocatorName: "Member ID",
        }),
        recorded({
          action: {
            name: "select",
            target: { primary: { by: "role", role: "combobox", name: "Reason" } },
            value: "Unauthorized",
          },
          usedLocatorName: "Reason",
        }),
      ],
    });
    expect(artifact.parameters.map((p) => p.name)).toEqual(["memberId", "reason"]);
    expect(artifact.parameters.find((p) => p.name === "memberId")?.type).toBe("string");
    expect(artifact.steps.some((s) => s.inputFrom === "parameters.reason")).toBe(true);
    expect(artifact.exceptionalStates.some((s) => s.code === "DISPUTE_NOT_FOUND")).toBe(true);
    expect(artifact.success.checkpoint.expect).toBe("Dispute filed");
  });

  it("attaches CARD_ALREADY_BLOCKED and SUPERVISOR_REQUIRED for block-and-reissue", () => {
    const artifact = compileArtifact({
      goal: "Block and reissue the debit card ending 4412 for member 12345 in CAMS.",
      targetUrl: "http://127.0.0.1:3000/",
      id: "block-and-reissue-card",
      outputs: { confirmation: "Confirmation: Card 4412 blocked and reissued. Case CASE-88001." },
      recorded: [
        recorded({
          action: {
            name: "click",
            target: { primary: { by: "role", role: "button", name: "Confirm" } },
          },
          usedLocatorName: "Confirm",
          risk: "risky",
        }),
      ],
    });
    expect(artifact.exceptionalStates.some((s) => s.code === "CARD_ALREADY_BLOCKED")).toBe(true);
    expect(artifact.exceptionalStates.some((s) => s.code === "SUPERVISOR_REQUIRED" && s.classify === "needs_human")).toBe(true);
    expect(artifact.success.checkpoint.expect).toBe("Card reissued");
    expect(artifact.sideEffects.kind).toBe("irreversible");
  });

  it("emits ranked locator chains role → label → text → css", () => {
    const artifact = compileArtifact({
      goal: "Look up member 12345",
      targetUrl: "http://127.0.0.1:3000/",
      outputs: { savingsBalance: "$4,250.00" },
      recorded: [
        recorded({
          action: {
            name: "click",
            target: { primary: { by: "role", role: "button", name: "Search" } },
          },
          observationBefore: obs({ text: "Member Lookup" }),
          observationAfter: obs({
            url: "http://127.0.0.1:3000/member/12345",
            title: "Member",
            text: "Savings Balance $4,250.00",
          }),
          usedLocatorName: "Search",
        }),
      ],
    });
    const click = artifact.steps.find((s) => s.action === "click");
    expect(click?.target?.primary).toEqual({ by: "role", role: "button", name: "Search" });
    expect(click?.target?.fallbacks?.map((f) => f.by)).toEqual(["label", "text", "css"]);
    expect(click?.target?.fallbacks?.[0]).toEqual({ by: "label", name: "Search" });
    expect(click?.target?.fallbacks?.[1]).toEqual({ by: "text", text: "Search" });
    expect(click?.target?.fallbacks?.[2]?.selector).toBe('[aria-label="Search"]');
  });

  it("emits per-step checkpoints from observation deltas and strips goal literals", () => {
    const artifact = compileArtifact({
      goal: "Look up member 12345",
      targetUrl: "http://127.0.0.1:3000/",
      outputs: { savingsBalance: "$4,250.00" },
      recorded: [
        recorded({
          action: {
            name: "click",
            target: { primary: { by: "role", role: "button", name: "Search" } },
          },
          observationBefore: obs({ title: "Member Lookup", text: "Member Lookup" }),
          observationAfter: obs({
            url: "http://127.0.0.1:3000/member/12345",
            title: "Member 12345",
            text: "Savings Balance $4,250.00",
          }),
          usedLocatorName: "Search",
        }),
      ],
    });
    const click = artifact.steps.find((s) => s.action === "click");
    expect(click?.checkpoint).toEqual({ kind: "urlIncludes", expect: "/member" });
    const navigate = artifact.steps.find((s) => s.id === "s00-navigate");
    expect(navigate?.checkpoint?.kind).toBe("titleIncludes");
    expect(JSON.stringify(artifact.steps.map((s) => s.checkpoint))).not.toContain("12345");
  });

  it("canonicalizes recorded member URLs as /member/:memberId once the param exists", () => {
    const artifact = compileArtifact({
      goal: "Look up member 12345",
      targetUrl: "http://127.0.0.1:3000/",
      outputs: { savingsBalance: "$4,250.00" },
      recorded: [
        recorded({
          action: {
            name: "type",
            target: { primary: { by: "role", role: "textbox", name: "Member ID" } },
            value: "12345",
          },
          usedLocatorName: "Member ID",
        }),
        recorded({
          action: {
            name: "click",
            target: { primary: { by: "role", role: "button", name: "Search" } },
          },
          observationBefore: obs({ title: "Member Lookup", text: "Member Lookup" }),
          observationAfter: obs({
            url: "http://127.0.0.1:3000/member/12345",
            title: "Member 12345",
            text: "Savings Balance $4,250.00",
          }),
          usedLocatorName: "Search",
        }),
      ],
    });
    const click = artifact.steps.find((s) => s.action === "click");
    expect(click?.checkpoint).toEqual({ kind: "urlIncludes", expect: "/member/:memberId" });
    expect(JSON.stringify(artifact.steps)).not.toContain("12345");
  });

  it("prefers a title checkpoint when the URL does not change, then text", () => {
    const titleOnly = compileArtifact({
      goal: "Stay on lookup",
      targetUrl: "http://127.0.0.1:3000/",
      outputs: {},
      recorded: [
        recorded({
          action: { name: "wait" },
          observationBefore: obs({ title: "Lookup", text: "Member Lookup" }),
          observationAfter: obs({ title: "Ready", text: "Member Lookup" }),
        }),
      ],
    });
    expect(titleOnly.steps.find((s) => s.action === "wait")?.checkpoint).toEqual({
      kind: "titleIncludes",
      expect: "Ready",
    });

    const textOnly = compileArtifact({
      goal: "Stay on lookup",
      targetUrl: "http://127.0.0.1:3000/",
      outputs: {},
      recorded: [
        recorded({
          action: { name: "wait" },
          observationBefore: obs({ title: "Lookup", text: "Member Lookup" }),
          observationAfter: obs({ title: "Lookup", text: "Member Lookup\nSystem Notice" }),
        }),
      ],
    });
    expect(textOnly.steps.find((s) => s.action === "wait")?.checkpoint?.kind).toBe("textIncludes");
  });

  it("strips query and hash from the entry URL", () => {
    const artifact = compileArtifact({
      goal: "Look up a member",
      targetUrl: "http://127.0.0.1:3000/?notice=1#top",
      outputs: {},
      recorded: [],
    });
    expect(artifact.steps[0]?.url).toBe("http://127.0.0.1:3000/");
  });

  it("infers an id and humanized name from the goal when --id is omitted", () => {
    const artifact = compileArtifact({
      goal: "Look up member 12345 and read their current savings balance",
      targetUrl: "http://127.0.0.1:3000/",
      outputs: {},
      recorded: [],
    });
    expect(artifact.id).toBe("look-up-member-12345-and-read-their-current-s");
    expect(artifact.name).toBe("Look Up Member 12345 And Read Their Current S");
    expect(artifact.id.length).toBeLessThanOrEqual(48);
  });

  it("falls back to capability when the goal has no slug tokens", () => {
    const artifact = compileArtifact({
      goal: "???",
      targetUrl: "http://127.0.0.1:3000/",
      outputs: {},
      recorded: [],
    });
    expect(artifact.id).toBe("capability");
  });

  it("marks a risky Confirm as irreversible with compensation and an idempotency key", () => {
    const artifact = compileArtifact({
      goal: 'Open a Share Savings sub-account for member 12345',
      targetUrl: "http://127.0.0.1:3000/",
      id: "open-sub-account",
      outputs: { confirmation: "Sub-account opened for Jane Doe" },
      recorded: [
        recorded({
          action: {
            name: "click",
            target: { primary: { by: "role", role: "button", name: "Confirm" } },
          },
          risk: "risky",
        }),
      ],
    });
    expect(artifact.sideEffects.kind).toBe("irreversible");
    expect(artifact.sideEffects.compensation).toMatch(/cannot undo/i);
    expect(artifact.idempotencyKeyFrom).toEqual(artifact.parameters.map((p) => p.name));
    expect(artifact.success.checkpoint.expect).toBe("Sub-account opened");
    expect(artifact.exceptionalStates.some((s) => s.code === "MEMBER_NOT_FOUND")).toBe(true);
    expect(artifact.exceptionalStates.some((s) => s.code === "DISPUTE_NOT_FOUND")).toBe(false);
  });

  it("flags sensitive parameter names", () => {
    const artifact = compileArtifact({
      goal: "Type secret hunter2 into the form",
      targetUrl: "http://127.0.0.1:3000/",
      outputs: {},
      recorded: [
        recorded({
          action: {
            name: "type",
            target: { primary: { by: "role", role: "textbox", name: "Password" } },
            value: "hunter2",
          },
          usedLocatorName: "Password",
        }),
      ],
    });
    expect(artifact.parameters.find((p) => p.name === "password")?.sensitive).toBe(true);
  });

  it("types a numeric field as number unless the name ends in Id", () => {
    const artifact = compileArtifact({
      goal: "Set amount 4250 on member 12345",
      targetUrl: "http://127.0.0.1:3000/",
      outputs: {},
      recorded: [
        recorded({
          action: {
            name: "type",
            target: { primary: { by: "role", role: "textbox", name: "Amount" } },
            value: "4250",
          },
          usedLocatorName: "Amount",
        }),
        recorded({
          action: {
            name: "type",
            target: { primary: { by: "role", role: "textbox", name: "Member ID" } },
            value: "12345",
          },
          usedLocatorName: "Member ID",
        }),
      ],
    });
    expect(artifact.parameters.find((p) => p.name === "amount")?.type).toBe("number");
    expect(artifact.parameters.find((p) => p.name === "memberId")?.type).toBe("string");
  });

  it("defaults success to Member when nothing else matches", () => {
    const artifact = compileArtifact({
      goal: "Do a thing",
      targetUrl: "http://127.0.0.1:3000/",
      outputs: {},
      recorded: [],
    });
    expect(artifact.success.checkpoint.expect).toBe("Member");
    expect(artifact.preconditions.entryCheckpoint.expect).toBe("Member Lookup");
  });

  it("emits a parseable capability", () => {
    const artifact = compileArtifact({
      goal: "Look up member 12345",
      targetUrl: "http://127.0.0.1:3000/",
      outputs: { savingsBalance: "$4,250.00" },
      recorded: [
        recorded({
          action: {
            name: "type",
            target: { primary: { by: "role", role: "textbox", name: "Member ID" } },
            value: "12345",
          },
        }),
      ],
    });
    expect(parseCapability(artifact).id).toBe(artifact.id);
  });

  it("scopes a generic Open click to merchant + last4 row cells", () => {
    const artifact = compileArtifact({
      goal: "Jane Doe called about an unauthorized charge from ACME POS on her card ending 4412.",
      targetUrl: "http://127.0.0.1:3000/",
      id: "verify-and-file-dispute",
      outputs: { confirmation: "Dispute filed" },
      recorded: [
        recorded({
          action: {
            name: "click",
            target: { primary: { by: "role", role: "link", name: "Open" } },
          },
          usedLocatorName: "Open",
          row: {
            headers: ["ID", "Merchant", "Card", "Amount", "Status", ""],
            cells: ["DSP-1001", "ACME POS", "4412", "$42.18", "open", "Open"],
          },
        }),
      ],
    });
    expect(artifact.parameters.map((p) => p.name)).toEqual(["merchant", "last4"]);
    const open = artifact.steps.find((s) => s.action === "click");
    expect(open?.target?.primary.scope).toEqual({ by: "row", hasText: [":merchant", ":last4"] });
    expect(JSON.stringify(artifact.steps)).not.toContain("DSP-1001");
    expect(JSON.stringify(artifact.steps)).not.toContain("ACME POS");
  });

  it("scopes Open to :memberId when the column header is Member ID", () => {
    const artifact = compileArtifact({
      goal: "Open member 12345 from a last-name search",
      targetUrl: "http://127.0.0.1:3000/",
      outputs: { savingsBalance: "$4,250.00" },
      recorded: [
        recorded({
          action: {
            name: "click",
            target: { primary: { by: "role", role: "link", name: "Open" } },
          },
          usedLocatorName: "Open",
          row: {
            headers: ["Member ID", "Name", ""],
            cells: ["12345", "Jane Doe", "Open"],
          },
        }),
      ],
    });
    expect(artifact.parameters.map((p) => p.name)).toContain("memberId");
    const open = artifact.steps.find((s) => s.action === "click");
    expect(open?.target?.primary.scope).toEqual({ by: "row", hasText: [":memberId"] });
  });

  it("promotes a rank-3 extract hit to a rebuilt a11y chain", () => {
    const v2 = promoteHits(LOOKUP_MEMBER_SAVINGS, [
      {
        stepId: "s03-extract",
        rank: 3,
        by: "text",
        locator: { by: "text", text: "Savings Balance" },
      },
    ]);
    expect(v2.version).toBe(LOOKUP_MEMBER_SAVINGS.version + 1);
    const extract = v2.steps.find((s) => s.id === "s03-extract");
    expect(extract?.target?.primary).toEqual({ by: "role", role: "cell", name: "Savings Balance" });
    expect(extract?.target?.fallbacks?.map((f) => f.by)).toEqual(["label", "text", "css"]);
  });
});
