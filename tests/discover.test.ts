import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DiscoveryAgent } from "../src/agent/discover.ts";
import { ScriptedLlm } from "../src/agent/providers.ts";
import { MemoryArtifactStore } from "../src/artifact/store.ts";
import { EvidenceStore } from "../src/evidence/store.ts";
import { MockSurface } from "../src/surfaces/mock.ts";

describe("discovery compiler", () => {
  it("turns a successful scripted run into a parameterized capability", async () => {
    const surface = new MockSurface();
    const evidence = new EvidenceStore("disc", mkdtempSync(join(tmpdir(), "relay-")));
    const store = new MemoryArtifactStore();
    const llm = new ScriptedLlm([
      { tool: "type", role: "textbox", name: "Member ID", text: "12345", reason: "enter id" },
      { tool: "click", role: "button", name: "Search", reason: "search" },
      {
        tool: "extract",
        role: "cell",
        name: "Savings Balance",
        outputName: "savingsBalance",
        reason: "read balance",
      },
      { tool: "finish", reason: "done", outputs: { savingsBalance: "$4,250.00" } },
    ]);
    const agent = new DiscoveryAgent(surface, llm, store, evidence);
    const out = await agent.run({
      goal: "Look up member 12345 and read their current savings balance",
      targetUrl: "http://127.0.0.1:3000/",
      capabilityId: "lookup-member-savings",
    });
    expect(out.result.status).toBe("success");
    expect(out.artifact?.parameters[0]?.name).toBe("memberId");
    expect(out.artifact?.steps.some((s) => s.inputFrom === "parameters.memberId")).toBe(true);
    const saved = await store.load("lookup-member-savings");
    expect(saved.outputs[0]?.name).toBe("savingsBalance");
    const lines = readFileSync(join(evidence.dir, "log.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { kind: string; data: Record<string, unknown> });
    const start = lines.find((e) => e.kind === "discover.start");
    const decide = lines.find((e) => e.kind === "discover.decide");
    expect(start?.data).toMatchObject({ provider: "scripted", model: "scripted", scripted: true });
    expect(decide?.data).toMatchObject({ provider: "scripted", model: "scripted", scripted: true });
  });
});
