import { describe, expect, it } from "vitest";
import { compileArtifact, LOOKUP_MEMBER_SAVINGS, VERIFY_AND_FILE_DISPUTE } from "../src/artifact/compile.ts";
import { parseCapability } from "../src/artifact/schema.ts";
import { MemoryArtifactStore } from "../src/artifact/store.ts";

describe("artifact schema", () => {
  it("accepts the golden lookup capability", () => {
    const parsed = parseCapability(LOOKUP_MEMBER_SAVINGS);
    expect(parsed.id).toBe("lookup-member-savings");
    expect(parsed.parameters[0]?.name).toBe("memberId");
    expect(parsed.success.checkpoint.expect).toBe("Savings Balance");
  });

  it("accepts the verify-and-file-dispute capability", () => {
    const parsed = parseCapability(VERIFY_AND_FILE_DISPUTE);
    expect(parsed.id).toBe("verify-and-file-dispute");
    expect(parsed.parameters.map((p) => p.name)).toEqual(["memberId", "disputeId", "reason"]);
    expect(parsed.steps.some((s) => s.id === "s10-confirm" && s.risk === "risky")).toBe(true);
    expect(parsed.exceptionalStates.some((s) => s.code === "DISPUTE_NOT_FOUND")).toBe(true);
  });

  it("rejects a missing success checkpoint", () => {
    expect(() => parseCapability({ ...LOOKUP_MEMBER_SAVINGS, success: {} })).toThrow();
  });

  it("parameterizes discovery values that appear in the goal", () => {
    const artifact = compileArtifact({
      goal: "Look up member 12345 and read their current savings balance",
      targetUrl: "http://127.0.0.1:3000/",
      outputs: { savingsBalance: "$4,250.00" },
      recorded: [
        {
          action: {
            name: "type",
            target: { primary: { by: "role", role: "textbox", name: "Member ID" } },
            value: "12345",
          },
          observationBefore: {
            url: "http://127.0.0.1:3000/",
            title: "search",
            aria: "",
            text: "",
            refs: [],
          },
          usedLocatorName: "Member ID",
          risk: "safe",
        },
      ],
    });
    expect(artifact.parameters.map((p) => p.name)).toContain("memberId");
    expect(artifact.steps.some((s) => s.inputFrom === "parameters.memberId")).toBe(true);
    expect(artifact.steps.every((s) => s.value !== "12345")).toBe(true);
  });

  it("drops consecutive duplicate extracts from the compiled capability", () => {
    const extract = {
      action: {
        name: "extract" as const,
        target: { primary: { by: "role" as const, role: "cell", name: "Savings Balance" } },
        outputName: "savingsBalance",
      },
      observationBefore: {
        url: "http://127.0.0.1:3000/member/12345",
        title: "member",
        aria: "",
        text: "",
        refs: [],
      },
      usedLocatorName: "Savings Balance",
      risk: "safe" as const,
    };
    const artifact = compileArtifact({
      goal: "Look up member 12345",
      targetUrl: "http://127.0.0.1:3000/",
      outputs: { savingsBalance: "$4,250.00" },
      recorded: [extract, extract],
    });
    expect(artifact.steps.filter((s) => s.action === "extract")).toHaveLength(1);
  });

  it("parameterizes quoted select values and attaches dispute exceptions", () => {
    const artifact = compileArtifact({
      goal: 'File dispute DSP-1001 for member 12345 with reason "Unauthorized"',
      targetUrl: "http://127.0.0.1:3000/",
      id: "verify-and-file-dispute",
      outputs: { confirmation: "Confirmation: Dispute DSP-1001 filed (Unauthorized). Case CASE-77201." },
      recorded: [
        {
          action: {
            name: "type",
            target: { primary: { by: "role", role: "textbox", name: "Member ID" } },
            value: "12345",
          },
          observationBefore: { url: "http://127.0.0.1:3000/", title: "", aria: "", text: "", refs: [] },
          usedLocatorName: "Member ID",
          risk: "safe",
        },
        {
          action: {
            name: "select",
            target: { primary: { by: "role", role: "combobox", name: "Reason" } },
            value: "Unauthorized",
          },
          observationBefore: { url: "http://127.0.0.1:3000/", title: "", aria: "", text: "", refs: [] },
          usedLocatorName: "Reason",
          risk: "safe",
        },
      ],
    });
    expect(artifact.parameters.map((p) => p.name)).toEqual(["memberId", "reason"]);
    expect(artifact.parameters.find((p) => p.name === "memberId")?.type).toBe("string");
    expect(artifact.steps.some((s) => s.inputFrom === "parameters.reason")).toBe(true);
    expect(artifact.exceptionalStates.some((s) => s.code === "DISPUTE_NOT_FOUND")).toBe(true);
    expect(artifact.success.checkpoint.expect).toBe("Dispute filed");
  });

  it("round-trips through the file-shaped store", async () => {
    const store = new MemoryArtifactStore();
    await store.save(LOOKUP_MEMBER_SAVINGS);
    const loaded = await store.load("lookup-member-savings");
    expect(loaded.outputs[0]?.name).toBe("savingsBalance");
  });
});
