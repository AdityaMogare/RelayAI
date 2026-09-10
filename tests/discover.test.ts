import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DiscoveryAgent } from "../src/agent/discover.ts";
import { ScriptedLlm } from "../src/agent/providers.ts";
import { MemoryArtifactStore } from "../src/artifact/store.ts";
import { ControlPlane, humanCompletesRiskyStep } from "../src/escalation/control.ts";
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
    expect(out.artifact?.schemaVersion).toBe("1.1");
    expect(out.artifact?.provenance.discoveredBy).toBe("human");
    expect(out.artifact?.provenance.model).toBe("scripted");
    expect(out.artifact?.sideEffects.kind).toBe("none");
    expect(out.artifact?.steps.every((s) => typeof s.timeoutMs === "number")).toBe(true);
    expect(out.artifact?.steps.some((s) => s.inputFrom === "parameters.memberId")).toBe(true);
    const saved = await store.load("lookup-member-savings");
    expect(saved.outputs[0]?.name).toBe("savingsBalance");
    expect(saved.outputs[0]?.pii).toBe(true);
    expect(saved.auth?.credentialRef).toBe("vault://tenant-9/teller");
    const lines = readFileSync(join(evidence.dir, "log.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { kind: string; data: Record<string, unknown> });
    const start = lines.find((e) => e.kind === "discover.start");
    const decide = lines.find((e) => e.kind === "discover.decide");
    const end = lines.find((e) => e.kind === "discover.end");
    expect(start?.data).toMatchObject({ provider: "scripted", model: "scripted", scripted: true });
    expect(decide?.data).toMatchObject({ provider: "scripted", model: "scripted", scripted: true });
    expect(typeof end?.data.contentHash).toBe("string");
    expect(String(end?.data.contentHash).length).toBe(64);
    expect(out.artifact?.steps.find((s) => s.action === "click")?.target?.fallbacks?.map((f) => f.by)).toEqual([
      "label",
      "text",
      "css",
    ]);
    expect(out.artifact?.steps.find((s) => s.action === "click")?.checkpoint?.kind).toBe("urlIncludes");
    expect(out.result.metrics?.modelCalls).toBeGreaterThan(0);
    expect(out.result.metrics?.costUsd).toBe(0);
  });

  it("resumes after a human step and stamps assistedBy", async () => {
    const surface = new MockSurface();
    const evidence = new EvidenceStore("assist", mkdtempSync(join(tmpdir(), "relay-")));
    const store = new MemoryArtifactStore();
    const control = new ControlPlane(
      surface,
      evidence,
      humanCompletesRiskyStep("teller01", async () => {}),
    );
    const llm = new ScriptedLlm([
      { tool: "type", role: "textbox", name: "Member ID", text: "Jane Doe", reason: "name from the call" },
      { tool: "click", role: "button", name: "Search", reason: "search" },
      { tool: "click", role: "link", name: "Disputes", reason: "queue" },
      { tool: "escalate", reason: "Unfamiliar Supervisor Attestation interstitial." },
      { tool: "click", role: "link", name: "Open", reason: "ACME POS row" },
      {
        tool: "extract",
        role: "cell",
        name: "Transaction Amount",
        outputName: "transactionAmount",
        reason: "amount",
      },
      { tool: "finish", reason: "verified", outputs: { transactionAmount: "$42.18" } },
    ]);
    const agent = new DiscoveryAgent(surface, llm, store, evidence);
    const out = await agent.run({
      goal: "Jane Doe called about an unauthorized charge from ACME POS on her card ending 4412.",
      targetUrl: "http://127.0.0.1:3000/",
      capabilityId: "file-by-merchant",
      control,
      maxSteps: 16,
    });
    expect(out.result.status).toBe("success");
    expect(out.artifact?.steps.some((s) => s.assistedBy === "teller01")).toBe(true);
    expect(out.artifact?.parameters.map((p) => p.name)).toEqual(expect.arrayContaining(["memberId"]));
  });
});
