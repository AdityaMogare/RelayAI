import { describe, expect, it } from "vitest";
import { compileArtifact, type RecordedStep } from "../src/artifact/compile.ts";
import { equivalentSteps, stepFingerprint } from "../src/artifact/equivalent.ts";
import type { Observation } from "../src/core/types.ts";

function obs(): Observation {
  return { url: "http://127.0.0.1:3000/", title: "", aria: "", text: "", refs: [] };
}

function recorded(action: RecordedStep["action"]): RecordedStep {
  return { action, observationBefore: obs(), risk: "safe" };
}

describe("two models, one artifact", () => {
  it("compiles equivalent step sequences from the same recording", () => {
    const recordedSteps: RecordedStep[] = [
      recorded({
        name: "type",
        target: { primary: { by: "role", role: "textbox", name: "Member ID" } },
        value: "Jane Doe",
      }),
      recorded({
        name: "click",
        target: { primary: { by: "role", role: "button", name: "Search" } },
      }),
    ];
    const gpt = compileArtifact({
      goal: "Find Jane Doe",
      targetUrl: "http://127.0.0.1:3000/",
      outputs: {},
      recorded: recordedSteps,
      provenance: { model: "gpt-4o", discoveredBy: "model" },
    });
    const claude = compileArtifact({
      goal: "Find Jane Doe",
      targetUrl: "http://127.0.0.1:3000/",
      outputs: {},
      recorded: structuredClone(recordedSteps),
      provenance: { model: "claude-sonnet-4-20250514", discoveredBy: "model" },
    });
    expect(gpt.provenance.model).toBe("gpt-4o");
    expect(claude.provenance.model).toBe("claude-sonnet-4-20250514");
    expect(equivalentSteps(gpt, claude)).toBe(true);
    expect(gpt.steps.map(stepFingerprint)).toEqual(claude.steps.map(stepFingerprint));
  });
});
