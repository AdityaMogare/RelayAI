import "dotenv/config";
import { Command } from "commander";
import { DiscoveryAgent } from "./agent/discover.ts";
import { createLlmClient, ScriptedLlm } from "./agent/providers.ts";
import { LOOKUP_MEMBER_SAVINGS, OPEN_SUB_ACCOUNT, VERIFY_AND_FILE_DISPUTE } from "./artifact/compile.ts";
import { FileArtifactStore } from "./artifact/store.ts";
import type { AgentDecision } from "./core/llm.ts";
import type { Capability } from "./core/types.ts";
import { ControlPlane, immediateResume } from "./escalation/control.ts";
import { createOperatorWaiter } from "./escalation/operator.ts";
import { EvidenceStore, newRunId } from "./evidence/store.ts";
import { ReplayEngine } from "./replay/engine.ts";
import { runStability } from "./replay/stability.ts";
import { WebSurface } from "./surfaces/web.ts";
import { startConsole } from "../apps/bank-console/server.ts";

async function loadCapability(idOrPath: string): Promise<Capability> {
  const store = new FileArtifactStore();
  try {
    return await store.load(idOrPath);
  } catch {
    if (idOrPath.includes("open-sub-account")) return OPEN_SUB_ACCOUNT;
    if (idOrPath.includes("verify-and-file-dispute") || idOrPath.includes("verify_and_file")) {
      return VERIFY_AND_FILE_DISPUTE;
    }
    return LOOKUP_MEMBER_SAVINGS;
  }
}

function parseInputs(values: string[]): Record<string, string> {
  const inputs: Record<string, string> = {};
  for (const value of values) {
    const idx = value.indexOf("=");
    if (idx === -1) throw new Error(`Expected key=value, got ${value}`);
    inputs[value.slice(0, idx)] = value.slice(idx + 1);
  }
  return inputs;
}

function headed(): boolean {
  return process.env.RELAY_HEADED === "1" || process.env.RELAY_HEADED === "true";
}

function printResult(result: unknown): void {
  console.log(JSON.stringify(result, null, 2));
}

const program = new Command();
program.name("relayai").description("Discover once with an LLM, replay forever without one.");

program
  .command("discover")
  .requiredOption("--goal <text>", "Natural-language goal")
  .requiredOption("--target <url>", "Entry URL of the target app")
  .option("--id <id>", "Capability id to write")
  .option("--max-steps <n>", "Max observe/decide/act iterations", "12")
  .option("--headed", "Show the browser")
  .option("--scripted", "Use a built-in scripted policy (no LLM) for offline demos")
  .action(async (opts) => {
    const runId = newRunId("discovery");
    const evidence = new EvidenceStore(runId);
    const surface = new WebSurface({ headed: Boolean(opts.headed) || headed() });
    await surface.launch();
    const store = new FileArtifactStore();
    const llm = opts.scripted ? new ScriptedLlm(scriptedLookup()) : createLlmClient();
    const control = new ControlPlane(
      surface,
      evidence,
      process.env.RELAY_AUTO_RESUME_MS
        ? immediateResume("auto-resume")
        : createOperatorWaiter({ autoResumeMs: Number(process.env.RELAY_AUTO_RESUME_MS ?? 0) || undefined }),
    );
    const agent = new DiscoveryAgent(surface, llm, store, evidence);
    try {
      const out = await agent.run({
        goal: opts.goal,
        targetUrl: opts.target,
        maxSteps: Number(opts.maxSteps),
        control,
        capabilityId: opts.id,
      });
      printResult({ ...out.result, artifactPath: out.artifactPath, evidence: evidence.dir });
      if (out.result.status === "failed") process.exitCode = 1;
    } finally {
      await surface.close();
    }
  });

program
  .command("replay")
  .requiredOption("--capability <idOrPath>", "Capability id or JSON path")
  .option("--input <key=value>", "Typed parameter", (v, acc: string[]) => [...acc, v], [] as string[])
  .option("--base-url <url>", "Override artifact host (ephemeral console ports)")
  .option("--approve-risky", "Allow irreversible steps without a human")
  .option("--headed", "Show the browser")
  .action(async (opts) => {
    const capability = await loadCapability(opts.capability);
    const runId = newRunId(`replay-${capability.id}`);
    const evidence = new EvidenceStore(runId);
    const surface = new WebSurface({ headed: Boolean(opts.headed) || headed() });
    await surface.launch();
    const engine = new ReplayEngine(surface, evidence);
    try {
      const result = await engine.run(capability, {
        inputs: parseInputs(opts.input),
        approveRisky: Boolean(opts.approveRisky),
        baseUrl: opts.baseUrl,
      });
      printResult({ ...result, evidence: evidence.dir });
      if (result.status === "failed") process.exitCode = 1;
    } finally {
      await surface.close();
    }
  });

program
  .command("escalate-demo")
  .option("--base-url <url>", "Console origin", "http://127.0.0.1:3000")
  .option("--auto-resume-ms <n>", "Resume automatically after N ms (for evidence)")
  .action(async (opts) => {
    const runId = newRunId("escalate-demo");
    const evidence = new EvidenceStore(runId);
    const surface = new WebSurface({ headed: true });
    await surface.launch();
    const autoResumeMs = Number(opts.autoResumeMs ?? process.env.RELAY_AUTO_RESUME_MS ?? 0);
    const waiter =
      autoResumeMs > 0
        ? createOperatorWaiter({ autoResumeMs })
        : createOperatorWaiter({});
    const control = new ControlPlane(surface, evidence, waiter);
    const engine = new ReplayEngine(surface, evidence);
    try {
      const result = await engine.run(OPEN_SUB_ACCOUNT, {
        inputs: { memberId: "12345", product: "Share Savings" },
        approveRisky: false,
        baseUrl: opts.baseUrl,
        control,
      });
      printResult({ ...result, evidence: evidence.dir, intervention: control.lastIntervention });
    } finally {
      await surface.close();
    }
  });

program
  .command("capabilities")
  .description("List or invoke saved capabilities (agent-facing catalog)")
  .argument("[action]", "list | invoke", "list")
  .option("--id <id>", "Capability id")
  .option("--input <key=value>", "Typed parameter", (v, acc: string[]) => [...acc, v], [] as string[])
  .option("--base-url <url>", "Override host")
  .option("--approve-risky")
  .action(async (action, opts) => {
    const store = new FileArtifactStore();
    await store.save(LOOKUP_MEMBER_SAVINGS);
    await store.save(OPEN_SUB_ACCOUNT);
    await store.save(VERIFY_AND_FILE_DISPUTE);
    if (action !== "invoke") {
      const items = await store.list();
      printResult(
        items.map((c) => ({
          id: c.id,
          name: c.name,
          description: c.description,
          parameters: c.parameters,
          outputs: c.outputs.map((o) => ({ name: o.name, type: o.type })),
        })),
      );
      return;
    }
    if (!opts.id) throw new Error("--id is required for invoke");
    const capability = await store.load(opts.id);
    const evidence = new EvidenceStore(newRunId(`invoke-${capability.id}`));
    const surface = new WebSurface({ headed: headed() });
    await surface.launch();
    try {
      const result = await new ReplayEngine(surface, evidence).run(capability, {
        inputs: parseInputs(opts.input),
        approveRisky: Boolean(opts.approveRisky),
        baseUrl: opts.baseUrl,
      });
      printResult(result);
    } finally {
      await surface.close();
    }
  });

program
  .command("stability")
  .description("Replay a capability N times and report a reliability signal")
  .requiredOption("--capability <idOrPath>", "Capability id or JSON path")
  .option("--input <key=value>", "Typed parameter", (v, acc: string[]) => [...acc, v], [] as string[])
  .option("--runs <n>", "Number of sequential replays", "5")
  .option("--base-url <url>", "Override artifact host")
  .option("--approve-risky", "Allow irreversible steps without a human")
  .option("--headed", "Show the browser")
  .action(async (opts) => {
    const capability = await loadCapability(opts.capability);
    const runs = Math.max(1, Number(opts.runs));
    const started = opts.baseUrl ? undefined : await startConsole(0);
    const baseUrl = opts.baseUrl ?? started?.origin;
    const surface = new WebSurface({ headed: Boolean(opts.headed) || headed() });
    await surface.launch();
    try {
      const report = await runStability({
        surface,
        capability,
        inputs: parseInputs(opts.input),
        runs,
        baseUrl,
        approveRisky: Boolean(opts.approveRisky),
      });
      printResult(report);
      if (report.failed > 0) process.exitCode = 1;
    } finally {
      await surface.close();
      await started?.close();
    }
  });

function scriptedLookup(): AgentDecision[] {
  return [
    { tool: "type", role: "textbox", name: "Member ID", text: "12345", reason: "Enter the member number from the goal." },
    { tool: "click", role: "button", name: "Search", reason: "Submit the lookup." },
    {
      tool: "extract",
      role: "cell",
      name: "Savings Balance",
      outputName: "savingsBalance",
      reason: "Read the savings balance.",
    },
    {
      tool: "finish",
      reason: "Savings balance is visible.",
      outputs: { savingsBalance: "$4,250.00" },
    },
  ];
}

await program.parseAsync(process.argv);
