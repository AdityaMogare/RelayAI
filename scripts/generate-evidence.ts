import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, join } from "node:path";
import { FileArtifactStore, MemoryArtifactStore } from "../src/artifact/store.ts";
import { promoteHits, rankedTarget } from "../src/artifact/ranked.ts";
import { ControlPlane, humanCompletesRiskyStep, immediateResume } from "../src/escalation/control.ts";
import { EvidenceStore } from "../src/evidence/store.ts";
import { writeEvidenceIndex } from "../src/evidence/catalog.ts";
import type { Capability, Observation, RunResult } from "../src/core/types.ts";
import { ReplayEngine } from "../src/replay/engine.ts";
import { runStability } from "../src/replay/stability.ts";
import { WebSurface } from "../src/surfaces/web.ts";
import { startConsole } from "../apps/bank-console/server.ts";
import { CU_WEST_SKIN, WESTSIDE_DRIFT_SKIN, WESTSIDE_SKIN } from "../apps/bank-console/skins.ts";
import { DiscoveryAgent } from "../src/agent/discover.ts";
import { ScriptedLlm } from "../src/agent/providers.ts";
import { JANE_DOE_DISPUTE_GOAL, scriptedAssistedDiscovery, scriptedLookup, scriptedLookupStuckHelp } from "../src/agent/scripts.ts";
import { compileArtifact } from "../src/artifact/compile.ts";
import { equivalentSteps } from "../src/artifact/equivalent.ts";
import { bindTenant } from "../src/overlay/store.ts";
import { costUsd } from "../src/agent/cost.ts";
import { loadRuntime, MemoryInvocationStore, RateLimiter } from "../src/policy/runtime.ts";

const ROOT = resolve(process.cwd(), "evidence");
const store = new FileArtifactStore();

function reset(runId: string): EvidenceStore {
  const dir = resolve(ROOT, runId);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return new EvidenceStore(runId, ROOT);
}

async function withSurface<T>(fn: (surface: WebSurface) => Promise<T>): Promise<T> {
  const surface = new WebSurface();
  await surface.launch();
  try {
    return await fn(surface);
  } finally {
    await surface.close();
  }
}

function withEntryQuery(capability: Capability, query: string): Capability {
  const q = query.replace(/^\?/, "");
  return {
    ...capability,
    steps: capability.steps.map((step) => {
      if (step.action !== "navigate" || !step.url) return step;
      const joiner = step.url.includes("?") ? "&" : "?";
      return { ...step, url: `${step.url}${joiner}${q}` };
    }),
  };
}

function brokenExtract(capability: Capability): Capability {
  return {
    ...capability,
    steps: capability.steps.map((step) =>
      step.id === "s03-extract"
        ? { ...step, target: { primary: { by: "role" as const, role: "cell", name: "Savins Balance" } } }
        : step,
    ),
  };
}

function rank3Extract(capability: Capability): Capability {
  return {
    ...capability,
    steps: capability.steps.map((step) =>
      step.action === "extract"
        ? {
            ...step,
            target: {
              primary: { by: "role" as const, role: "cell", name: "Savins Balance" },
              fallbacks: [
                { by: "label" as const, name: "Savins Balance" },
                { by: "text" as const, text: "Savings Balance" },
                { by: "css" as const, selector: '[aria-label="Savins Balance"]' },
              ],
            },
          }
        : step,
    ),
  };
}

function lastNameLookup(capability: Capability): Capability {
  const nav = capability.steps.find((step) => step.action === "navigate");
  const extract = capability.steps.find((step) => step.action === "extract");
  if (!nav || !extract) throw new Error("lookup capability missing navigate/extract");
  return {
    ...capability,
    id: "lookup-member-by-last-name",
    parameters: [
      { name: "lastName", type: "string", description: "Last name to search.", sensitive: false },
      { name: "memberId", type: "string", description: "Which result row to open.", sensitive: false },
    ],
    steps: [
      nav,
      {
        id: "s01-type-last",
        action: "type",
        target: rankedTarget("textbox", "Last Name"),
        inputFrom: "parameters.lastName",
        risk: "safe",
        timeoutMs: 8000,
        retryBudget: 3,
      },
      {
        id: "s02-search",
        action: "click",
        target: rankedTarget("button", "Search"),
        risk: "safe",
        checkpoint: { kind: "textIncludes", expect: "members named" },
        timeoutMs: 8000,
        retryBudget: 3,
      },
      {
        id: "s03-open",
        action: "click",
        target: rankedTarget("link", "Open", { by: "row", hasText: [":memberId"] }),
        risk: "safe",
        checkpoint: { kind: "urlIncludes", expect: "/member" },
        timeoutMs: 8000,
        retryBudget: 3,
      },
      { ...extract, id: "s04-extract" },
    ],
  };
}

function wireProbe(capability: Capability): Capability {
  const nav = capability.steps.find((step) => step.action === "navigate");
  if (!nav) throw new Error("lookup capability missing navigate");
  return {
    ...capability,
    id: "probe-admin-wire",
    outputs: [],
    steps: [
      nav,
      {
        id: "s01-wire",
        action: "click",
        target: rankedTarget("link", "Wire Transfer"),
        risk: "safe",
        timeoutMs: 8000,
        retryBudget: 1,
      },
    ],
    success: { checkpoint: { kind: "textIncludes", expect: "This screen is not reachable" } },
  };
}

function countDecides(runId: string): { model: string; calls: number; durationMs: number } {
  const logPath = resolve(ROOT, runId, "log.jsonl");
  if (!existsSync(logPath)) return { model: "unknown", calls: 0, durationMs: 0 };
  let calls = 0;
  let model = "unknown";
  let first = 0;
  let last = 0;
  for (const line of readFileSync(logPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const event = JSON.parse(line) as { at?: string; kind?: string; data?: { model?: string } };
    const at = event.at ? Date.parse(event.at) : 0;
    if (at && !first) first = at;
    if (at) last = at;
    if (event.kind === "discover.decide") {
      calls += 1;
      if (event.data?.model) model = event.data.model;
    }
  }
  return { model, calls, durationMs: Math.max(0, last - first) };
}

function stitchGif(dir: string, frames: string[], outName: string): string | undefined {
  const existing = frames.filter((name) => existsSync(join(dir, name)));
  if (existing.length < 2) return undefined;
  const out = join(dir, outName);
  const args = ["-y"];
  for (const name of existing) {
    args.push("-loop", "1", "-t", "1.2", "-i", join(dir, name));
  }
  const concat = existing.map((_, i) => `[${i}:v]`).join("");
  args.push("-filter_complex", `${concat}concat=n=${existing.length}:v=1:a=0,format=rgb8`, "-r", "1", out);
  const result = spawnSync("ffmpeg", args, { encoding: "utf8" });
  if (result.status !== 0 || !existsSync(out)) {
    console.log("ffmpeg gif skipped", result.stderr?.slice(0, 200));
    return undefined;
  }
  return out;
}

function stampDiscoveryHash(runId: string, capabilityPath: string, contentHash: string): void {
  const logPath = resolve(ROOT, runId, "log.jsonl");
  const raw = readFileSync(logPath, "utf8");
  if (raw.includes('"contentHash"')) return;
  const line = JSON.stringify({
    at: new Date().toISOString(),
    runId,
    kind: "discover.artifact",
    data: { artifactPath: capabilityPath, contentHash },
  });
  writeFileSync(logPath, `${raw.trimEnd()}\n${line}\n`, "utf8");
}

const consoleServer = await startConsole(0);
const baseUrl = consoleServer.origin;
console.log(`console ${baseUrl}`);

try {
  const lookup = await store.loadWithHash("capabilities/lookup-member-savings.json");
  const openSub = await store.loadWithHash("capabilities/open-sub-account.json");
  const dispute = await store.loadWithHash("capabilities/verify-and-file-dispute.json");
  const card = await store.loadWithHash("capabilities/block-and-reissue-card.json");
  const cardInputs = { memberId: "12345", last4: "4412" };
  const cardSql = "SELECT count(*) FROM card_actions WHERE member_id='12345' AND last4='4412'";

  let lookupReplay: RunResult | undefined;
  let disputeReplay: RunResult | undefined;

  stampDiscoveryHash("discovery-lookup-member-savings", lookup.path, lookup.contentHash);
  stampDiscoveryHash("discovery-verify-and-file-dispute", dispute.path, dispute.contentHash);
  console.log("discovery preserved (live-model evidence); stamped contentHash of capabilities/*.json");

  await withSurface(async (surface) => {
    const evidence = reset("replay-lookup-success");
    lookupReplay = await new ReplayEngine(surface, evidence).run(lookup.capability, {
      inputs: { memberId: "12345" },
      baseUrl,
      artifactPath: lookup.path,
      contentHash: lookup.contentHash,
    });
    console.log("replay success", lookupReplay.status, lookupReplay.outputs, lookup.contentHash);
  });

  await withSurface(async (surface) => {
    const evidence = reset("replay-lookup-not-found");
    const result = await new ReplayEngine(surface, evidence).run(lookup.capability, {
      inputs: { memberId: "99999" },
      baseUrl,
      artifactPath: lookup.path,
      contentHash: lookup.contentHash,
    });
    console.log("replay not-found", result.status, result.code);
  });

  await withSurface(async (surface) => {
    const evidence = reset("escalate-open-sub-account");
    const control = new ControlPlane(surface, evidence, immediateResume("auto-resume"));
    const result = await new ReplayEngine(surface, evidence).run(openSub.capability, {
      inputs: { memberId: "12345", product: "Share Savings" },
      baseUrl,
      control,
      artifactPath: openSub.path,
      contentHash: openSub.contentHash,
    });
    console.log("escalate", result.status, control.lastIntervention?.reason, control.lastHumanNote);
  });

  await withSurface(async (surface) => {
    const evidence = reset("escalate-verify-and-file-dispute");
    consoleServer.reset();
    const control = new ControlPlane(
      surface,
      evidence,
      humanCompletesRiskyStep("teller01", async () => {
        const clicked = await surface.actAsHuman({
          name: "click",
          target: { primary: { by: "role", role: "button", name: "Confirm" } },
        });
        if (!clicked.ok) throw new Error(clicked.error ?? "operator Confirm failed");
      }),
    );
    const result = await new ReplayEngine(surface, evidence).run(dispute.capability, {
      inputs: { memberId: "12345", merchant: "ACME POS", last4: "4412", reason: "Unauthorized" },
      baseUrl,
      control,
      artifactPath: dispute.path,
      contentHash: dispute.contentHash,
    });
    const sql = "SELECT count(*) FROM filings WHERE dispute_id='DSP-1001'";
    const proof = consoleServer.filings.exec(sql);
    evidence.saveJson("filings-proof.json", {
      ...proof,
      rows: consoleServer.filings.all(),
      intervention: control.lastIntervention,
      operatorKind: control.lastIntervention?.operatorKind ?? "scripted",
    });
    if (proof.count !== 1) {
      throw new Error(`${sql} expected 1, got ${proof.count}`);
    }
    console.log("escalate dispute", result.status, proof, control.lastIntervention?.operatorId);
  });

  await withSurface(async (surface) => {
    const evidence = reset("replay-verify-dispute-success");
    consoleServer.reset();
    disputeReplay = await new ReplayEngine(surface, evidence).run(dispute.capability, {
      inputs: { memberId: "12345", merchant: "ACME POS", last4: "4412", reason: "Unauthorized" },
      baseUrl,
      approveRisky: true,
      artifactPath: dispute.path,
      contentHash: dispute.contentHash,
    });
    console.log("dispute success", disputeReplay.status, disputeReplay.outputs);
  });

  await withSurface(async (surface) => {
    const evidence = reset("replay-verify-dispute-already-filed");
    const result = await new ReplayEngine(surface, evidence).run(dispute.capability, {
      inputs: { memberId: "12345", merchant: "ACME POS", last4: "4412", reason: "Unauthorized" },
      baseUrl,
      approveRisky: true,
      artifactPath: dispute.path,
      contentHash: dispute.contentHash,
    });
    evidence.saveJson("filings-proof.json", consoleServer.filings.exec("SELECT count(*) FROM filings WHERE dispute_id='DSP-1001'"));
    console.log("dispute already-filed", result.status, result.code);
  });

  await withSurface(async (surface) => {
    const evidence = reset("replay-verify-dispute-not-found");
    const result = await new ReplayEngine(surface, evidence).run(dispute.capability, {
      inputs: { memberId: "12345", merchant: "NO-SUCH", last4: "0000", reason: "Unauthorized" },
      baseUrl,
      approveRisky: true,
      artifactPath: dispute.path,
      contentHash: dispute.contentHash,
    });
    console.log("dispute not-found", result.status, result.code);
  });

  await withSurface(async (surface) => {
    const evidence = reset("replay-recoverable-notice");
    const result = await new ReplayEngine(surface, evidence).run(withEntryQuery(lookup.capability, "notice=1"), {
      inputs: { memberId: "12345" },
      baseUrl,
      artifactPath: lookup.path,
      contentHash: lookup.contentHash,
    });
    console.log("recoverable notice", result.status, result.code);
  });

  await withSurface(async (surface) => {
    const evidence = reset("replay-hard-failure-locator");
    const result = await new ReplayEngine(surface, evidence).run(brokenExtract(lookup.capability), {
      inputs: { memberId: "12345" },
      baseUrl,
      artifactPath: lookup.path,
      contentHash: lookup.contentHash,
    });
    console.log("hard failure locator", result.status, result.code, result.stepId);
  });

  await withSurface(async (surface) => {
    const evidence = reset("replay-needs-human-expired");
    const result = await new ReplayEngine(surface, evidence).run(withEntryQuery(lookup.capability, "expired=1"), {
      inputs: { memberId: "12345" },
      baseUrl,
      artifactPath: lookup.path,
      contentHash: lookup.contentHash,
    });
    console.log("needs human expired", result.status, result.code);
  });

  await withSurface(async (surface) => {
    const evidence = reset("replay-output-empty-amount");
    const result = await new ReplayEngine(surface, evidence).run(dispute.capability, {
      inputs: { memberId: "12345", merchant: "MAINFRAME TIMEOUT", last4: "4412", reason: "Unauthorized" },
      baseUrl,
      approveRisky: true,
      artifactPath: dispute.path,
      contentHash: dispute.contentHash,
    });
    console.log("empty amount", result.status, result.code, result.stepId, result.observed);
  });

  await withSurface(async (surface) => {
    const evidence = reset("replay-recoverable-exhausted");
    const result = await new ReplayEngine(surface, evidence).run(withEntryQuery(lookup.capability, "notice=always"), {
      inputs: { memberId: "12345" },
      baseUrl,
      artifactPath: lookup.path,
      contentHash: lookup.contentHash,
    });
    console.log("recoverable exhausted", result.status, result.code);
  });

  await withSurface(async (surface) => {
    const evidence = reset("discovery-legacy-frameset");
    const store = new MemoryArtifactStore();
    const agent = new DiscoveryAgent(surface, new ScriptedLlm(scriptedLookup()), store, evidence);
    const out = await agent.run({
      goal: "Look up member 12345 and read their current savings balance",
      targetUrl: `${baseUrl}/?legacy=1`,
      capabilityId: "lookup-member-savings-frameset",
    });
    if (out.artifact) evidence.saveJson("artifact.json", out.artifact);
    console.log("legacy frameset discovery", out.result.status, out.artifact?.app.surfaceKind);
  });

  await withSurface(async (surface) => {
    const evidence = reset("discovery-assisted-escalation");
    const store = new MemoryArtifactStore();
    const control = new ControlPlane(
      surface,
      evidence,
      humanCompletesRiskyStep("teller01", async () => {
        const seen = await surface.observe();
        if (/Savings Balance/i.test(seen.text)) return;
        await surface.actAsHuman({
          name: "type",
          target: { primary: { by: "role", role: "textbox", name: "Member ID" } },
          value: "12345",
        });
        const clicked = await surface.actAsHuman({
          name: "click",
          target: { primary: { by: "role", role: "button", name: "Search" } },
        });
        if (!clicked.ok) throw new Error(clicked.error ?? "operator Search failed");
      }),
    );
    const agent = new DiscoveryAgent(surface, new ScriptedLlm(scriptedLookupStuckHelp()), store, evidence);
    const out = await agent.run({
      goal: "Look up member 12345 and read their current savings balance",
      targetUrl: `${baseUrl}/`,
      capabilityId: "lookup-member-savings-assisted",
      control,
      maxSteps: 16,
    });
    if (out.artifact) evidence.saveJson("artifact.json", out.artifact);
    console.log("assisted discovery", out.result.status, out.artifact?.provenance.assistedBy);
  });

  await withSurface(async (surface) => {
    const evidence = reset("discovery-assisted-attest");
    const store = new MemoryArtifactStore();
    const control = new ControlPlane(
      surface,
      evidence,
      humanCompletesRiskyStep("teller01", async () => {
        const clicked = await surface.actAsHuman({
          name: "click",
          target: { primary: { by: "role", role: "button", name: "I attest" } },
        });
        if (!clicked.ok) throw new Error(clicked.error ?? "operator I attest failed");
      }),
    );
    const agent = new DiscoveryAgent(surface, new ScriptedLlm(scriptedAssistedDiscovery()), store, evidence);
    const out = await agent.run({
      goal: JANE_DOE_DISPUTE_GOAL,
      targetUrl: `${baseUrl}/?attest=1`,
      capabilityId: "verify-and-file-dispute-assisted",
      control,
      maxSteps: 20,
    });
    if (out.artifact) evidence.saveJson("artifact.json", out.artifact);
    console.log(
      "assisted attest discovery",
      out.result.status,
      out.artifact?.steps.find((s) => s.assistedBy)?.assistedBy,
    );
  });

  const westDrift = await startConsole(0, { skin: WESTSIDE_DRIFT_SKIN });
  try {
    const report = await rediscover({
      capability: dispute.capability,
      capabilityPath: dispute.path,
      tenantId: "westside-drift",
      baseUrl: westDrift.origin,
      scripted: true,
    });
    const dest = resolve(ROOT, "rediscover-verify-and-file-dispute");
    rmSync(dest, { recursive: true, force: true });
    cpSync(report.evidence, dest, { recursive: true });
    writeFileSync(resolve(dest, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(
      "rediscover westside-drift",
      "v1",
      report.replayV1.confidence,
      report.replayV1.needsRediscovery,
      "v2",
      report.replayV2?.status,
      report.replayV2?.confidence,
    );
  } finally {
    await westDrift.close();
  }

  {
    const empty: Observation = { url: "http://127.0.0.1:3000/", title: "", aria: "", text: "", refs: [] };
    const recorded = [
      {
        action: {
          name: "type" as const,
          target: { primary: { by: "role" as const, role: "textbox", name: "Member ID" } },
          value: "Jane Doe",
        },
        observationBefore: empty,
        risk: "safe" as const,
      },
      {
        action: {
          name: "click" as const,
          target: { primary: { by: "role" as const, role: "link", name: "Open" } },
        },
        observationBefore: empty,
        risk: "safe" as const,
        row: {
          headers: ["ID", "Merchant", "Card", "Amount", "Status", ""],
          cells: ["DSP-1001", "ACME POS", "4412", "$42.18", "open", "Open"],
        },
      },
    ];
    const gpt = compileArtifact({
      goal: JANE_DOE_DISPUTE_GOAL,
      targetUrl: "http://127.0.0.1:3000/",
      outputs: {},
      recorded,
      provenance: { model: "gpt-4o", discoveredBy: "model" },
    });
    const claude = compileArtifact({
      goal: JANE_DOE_DISPUTE_GOAL,
      targetUrl: "http://127.0.0.1:3000/",
      outputs: {},
      recorded: structuredClone(recorded),
      provenance: { model: "claude-sonnet-4-20250514", discoveredBy: "model" },
    });
    const dir = resolve(ROOT, "equivalent-models");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "gpt-4o.json"), `${JSON.stringify(gpt, null, 2)}\n`);
    writeFileSync(join(dir, "claude-sonnet.json"), `${JSON.stringify(claude, null, 2)}\n`);
    writeFileSync(
      join(dir, "result.json"),
      `${JSON.stringify(
        {
          equivalent: equivalentSteps(gpt, claude),
          gptModel: gpt.provenance.model,
          claudeModel: claude.provenance.model,
          parameters: gpt.parameters.map((p) => p.name),
          note: "Same recording, two provenance stamps. Discovery is model-dependent; the compiled step sequence is not. Live dual-model is `discover --provider openai|anthropic` — this folder does not fake live API traces.",
        },
        null,
        2,
      )}\n`,
    );
    console.log("equivalent models", equivalentSteps(gpt, claude), gpt.parameters.map((p) => p.name));
  }

  const westside = await startConsole(0, { skin: WESTSIDE_SKIN });
  try {
    await withSurface(async (surface) => {
      const evidence = reset("replay-tenant-westside-overlay");
      const bound = bindTenant(lookup.capability, "westside", { baseUrl: westside.origin, tenantId: "westside" });
      const result = await new ReplayEngine(surface, evidence).run(bound.capability, {
        inputs: { memberId: "12345" },
        baseUrl: westside.origin,
        tenantId: "westside",
        overlayTrace: bound.trace,
        artifactPath: lookup.path,
        contentHash: lookup.contentHash,
      });
      evidence.saveJson("overlay.json", bound.trace);
      console.log("westside overlay", result.status, result.needsRediscovery, bound.trace.copy.Search);
    });
  } finally {
    await westside.close();
  }

  await withSurface(async (surface) => {
    const evidence = reset("replay-legacy-hostile");
    const result = await new ReplayEngine(surface, evidence).run(withEntryQuery(lookup.capability, "legacy=1"), {
      inputs: { memberId: "12345" },
      baseUrl,
      artifactPath: lookup.path,
      contentHash: lookup.contentHash,
    });
    evidence.saveJson("legacy.json", {
      status: result.status,
      needsRediscovery: result.needsRediscovery,
      confidence: result.confidence,
      locatorHits: result.locatorHits,
    });
    console.log("legacy hostile", result.status, result.needsRediscovery, result.confidence, result.locatorHits);
  });
  const west = await startConsole(0, { skin: CU_WEST_SKIN });
  try {
    await withSurface(async (surface) => {
      const evidence = reset("replay-tenant-westside");
      const bound = bindTenant(lookup.capability, "tenant-14", { baseUrl: west.origin, tenantId: "tenant-14" });
      const result = await new ReplayEngine(surface, evidence).run(bound.capability, {
        inputs: { memberId: "12345" },
        baseUrl: west.origin,
        tenantId: "tenant-14",
        overlayTrace: bound.trace,
        artifactPath: lookup.path,
        contentHash: lookup.contentHash,
      });
      evidence.saveJson("overlay.json", bound.trace);
      console.log("tenant westside", result.status, bound.trace.copy.Search);
    });
  } finally {
    await west.close();
  }

  await withSurface(async (surface) => {
    const evidence = reset("replay-drift-rediscovery");
    const poisoned = rank3Extract(lookup.capability);
    const degraded = await new ReplayEngine(surface, evidence).run(poisoned, {
      inputs: { memberId: "12345" },
      baseUrl,
      artifactPath: lookup.path,
      contentHash: lookup.contentHash,
    });
    evidence.saveJson("v1-degraded.json", {
      status: degraded.status,
      confidence: degraded.confidence,
      needsRediscovery: degraded.needsRediscovery,
      locatorHits: degraded.locatorHits,
    });
    const v2 = promoteHits(poisoned, degraded.locatorHits ?? []);
    evidence.saveJson("artifact-v2.json", v2);
    const recovered = await new ReplayEngine(surface, evidence).run(v2, {
      inputs: { memberId: "12345" },
      baseUrl,
    });
    evidence.saveJson("v2-recovered.json", {
      status: recovered.status,
      confidence: recovered.confidence,
      needsRediscovery: recovered.needsRediscovery,
      version: v2.version,
      locatorHits: recovered.locatorHits,
    });
    console.log(
      "drift rediscovery",
      degraded.status,
      degraded.confidence,
      "→ v",
      v2.version,
      recovered.status,
      recovered.confidence,
    );
  });

  await withSurface(async (surface) => {
    const evidence = reset("replay-session-expired-reauth");
    const control = new ControlPlane(
      surface,
      evidence,
      humanCompletesRiskyStep("teller01", async () => {
        const clicked = await surface.actAsHuman({
          name: "click",
          target: { primary: { by: "role", role: "button", name: "Sign In" } },
        });
        if (!clicked.ok) throw new Error(clicked.error ?? "Sign In failed");
      }),
    );
    const result = await new ReplayEngine(surface, evidence).run(withEntryQuery(lookup.capability, "expireMid=1"), {
      inputs: { memberId: "12345" },
      baseUrl,
      control,
      artifactPath: lookup.path,
      contentHash: lookup.contentHash,
    });
    console.log("session reauth", result.status, result.code);
  });

  await withSurface(async (surface) => {
    const evidence = reset("replay-ambiguous-row");
    const artifact = lastNameLookup(lookup.capability);
    evidence.saveJson("artifact.json", artifact);
    const result = await new ReplayEngine(surface, evidence).run(artifact, {
      inputs: { lastName: "Doe", memberId: "12345" },
      baseUrl,
    });
    console.log("ambiguous row", result.status, result.outputs);
  });

  await withSurface(async (surface) => {
    const evidence = reset("policy-blocked-admin-wire");
    const result = await new ReplayEngine(surface, evidence).run(wireProbe(lookup.capability), {
      inputs: { memberId: "12345" },
      baseUrl,
    });
    console.log("policy blocked wire", result.status, result.code);
  });

  let stabilityReport: Awaited<ReturnType<typeof runStability>> | undefined;
  await withSurface(async (surface) => {
    const evidence = reset("stability-50");
    stabilityReport = await runStability({
      surface,
      capability: lookup.capability,
      inputs: { memberId: "12345" },
      runs: 50,
      baseUrl,
      artifactPath: lookup.path,
      contentHash: lookup.contentHash,
    });
    evidence.saveJson("result.json", stabilityReport);
    evidence.event("stability.report", {
      runs: stabilityReport.runs,
      rate: stabilityReport.rate,
      fallbackRate: stabilityReport.fallbackRate,
      p50DurationMs: stabilityReport.p50DurationMs,
      p95DurationMs: stabilityReport.p95DurationMs,
    });
    console.log(
      "stability-50",
      stabilityReport.rate,
      stabilityReport.fallbackRate,
      stabilityReport.p50DurationMs,
      stabilityReport.p95DurationMs,
    );
  });

  await withSurface(async (surface) => {
    const evidence = reset("escalate-verify-and-file-dispute-human");
    consoleServer.reset();
    const control = new ControlPlane(
      surface,
      evidence,
      humanCompletesRiskyStep("teller01", async () => {
        const clicked = await surface.actAsHuman({
          name: "click",
          target: { primary: { by: "role", role: "button", name: "Confirm" } },
        });
        if (!clicked.ok) throw new Error(clicked.error ?? "operator Confirm failed");
      }),
    );
    const result = await new ReplayEngine(surface, evidence).run(dispute.capability, {
      inputs: { memberId: "12345", merchant: "ACME POS", last4: "4412", reason: "Unauthorized" },
      baseUrl,
      control,
      artifactPath: dispute.path,
      contentHash: dispute.contentHash,
    });
    const gif = stitchGif(evidence.dir, ["handoff-before.png", "handoff-after.png"], "handoff.gif");
    if (gif) {
      const shared = resolve(ROOT, "escalate-verify-and-file-dispute", "handoff.gif");
      copyFileSync(gif, shared);
    }
    console.log("human escalate gif", result.status, gif ?? "no-ffmpeg");
  });

  // batch-40 is uncapped: runtime.yaml is 30/hr, which would stop a 40-invoke soak.
  // A fresh RateLimiter is not wired here. replay-batch-cap-exceeded uses the 30/hr lever.
  await withSurface(async (surface) => {
    const evidence = reset("replay-batch-reissue-40");
    const statuses: string[] = [];
    const engine = new ReplayEngine(surface, evidence);
    for (let i = 0; i < 40; i += 1) {
      consoleServer.reset();
      const result = await engine.run(card.capability, {
        inputs: cardInputs,
        baseUrl,
        approveRisky: true,
        artifactPath: card.path,
        contentHash: card.contentHash,
      });
      statuses.push(result.status);
      if (result.status !== "success") {
        throw new Error(`batch-40 invoke ${i + 1} expected success, got ${result.status}/${result.code}`);
      }
    }
    evidence.saveJson("result.json", {
      status: "success",
      runs: 40,
      success: statuses.filter((s) => s === "success").length,
      limiter: "uncapped — runtime.yaml 30/hr would stop this volume run",
    });
    console.log("batch reissue 40", statuses.filter((s) => s === "success").length);
  });

  await withSurface(async (surface) => {
    const evidence = reset("replay-batch-cap-exceeded");
    const limiter = new RateLimiter(new MemoryInvocationStore(), loadRuntime().blastRadius);
    const engine = new ReplayEngine(surface, evidence);
    let last: RunResult | undefined;
    for (let i = 0; i < 31; i += 1) {
      consoleServer.reset();
      last = await engine.run(card.capability, {
        inputs: cardInputs,
        baseUrl,
        approveRisky: true,
        artifactPath: card.path,
        contentHash: card.contentHash,
        limiter,
        tenantId: "tenant-9",
      });
      if (i < 30 && last.status !== "success") {
        throw new Error(`cap-exceeded invoke ${i + 1} expected success, got ${last.status}/${last.code}`);
      }
    }
    const proof = consoleServer.cardActions.exec(cardSql);
    evidence.saveJson("card-actions-proof.json", proof);
    if (last?.status !== "failed" || last.code !== "RATE_LIMIT") {
      throw new Error(`31st invoke expected failed/RATE_LIMIT, got ${last?.status}/${last?.code}`);
    }
    if (proof.count !== 0) {
      throw new Error(`${cardSql} after RATE_LIMIT expected 0 (console reset before #31), got ${proof.count}`);
    }
    console.log("batch cap exceeded", last.status, last.code, proof);
  });

  await withSurface(async (surface) => {
    const evidence = reset("replay-batch-idempotency");
    consoleServer.reset();
    const engine = new ReplayEngine(surface, evidence);
    const first = await engine.run(card.capability, {
      inputs: cardInputs,
      baseUrl,
      approveRisky: true,
      artifactPath: card.path,
      contentHash: card.contentHash,
    });
    const second = await engine.run(card.capability, {
      inputs: cardInputs,
      baseUrl,
      approveRisky: true,
      artifactPath: card.path,
      contentHash: card.contentHash,
    });
    const proof = consoleServer.cardActions.exec(cardSql);
    evidence.saveJson("card-actions-proof.json", {
      ...proof,
      rows: consoleServer.cardActions.all(),
      first: { status: first.status, code: first.code },
      second: { status: second.status, code: second.code },
    });
    if (proof.count !== 1) {
      throw new Error(`${cardSql} expected 1, got ${proof.count}`);
    }
    console.log("batch idempotency", first.status, second.status, second.code, proof);
  });

  await withSurface(async (surface) => {
    const evidence = reset("escalate-batch-business-account");
    consoleServer.reset();
    const control = new ControlPlane(surface, evidence, immediateResume("auto-resume"));
    const result = await new ReplayEngine(surface, evidence).run(card.capability, {
      inputs: { memberId: "12345", last4: "3301" },
      baseUrl,
      control,
      artifactPath: card.path,
      contentHash: card.contentHash,
    });
    if (result.status !== "escalated" || result.code !== "SUPERVISOR_REQUIRED") {
      throw new Error(`business-account expected escalated/SUPERVISOR_REQUIRED, got ${result.status}/${result.code}`);
    }
    if (!control.lastIntervention) {
      throw new Error("business-account expected a ControlPlane intervention");
    }
    console.log("escalate business account", result.status, result.code, control.lastIntervention.id);
  });

  const lookupDecides = countDecides("discovery-lookup-member-savings");
  const disputeDecides = countDecides("discovery-verify-and-file-dispute");
  const EST_IN = 1800;
  const EST_OUT = 220;
  const disputeCost = Number(
    costUsd(disputeDecides.model, disputeDecides.calls * EST_IN, disputeDecides.calls * EST_OUT).toFixed(4),
  );
  const replayMs = disputeReplay?.metrics?.durationMs ?? 0;
  const speedup = replayMs > 0 ? (disputeDecides.durationMs / replayMs).toFixed(1) : "?";
  const stabilityMs = (stabilityReport?.durationsMs ?? []).reduce((a, b) => a + b, 0);
  const costTable = {
    note: "Live discovery logs from these folders did not record token usage. Cost is estimated as modelCalls × ~1800 input + ~220 output tokens at gpt-4o list prices ($2.50 / $10 per 1M). Replay is $0. Durations are wall-clock from the committed traces.",
    table: [
      formatMetrics("discovery", disputeDecides.model || "gpt-4o", {
        durationMs: disputeDecides.durationMs,
        modelCalls: disputeDecides.calls,
        inputTokens: disputeDecides.calls * EST_IN,
        outputTokens: disputeDecides.calls * EST_OUT,
        costUsd: disputeCost,
      }),
      formatMetrics("replay", "none", {
        durationMs: replayMs,
        modelCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      }, `${speedup}× faster, 100% cheaper`),
      formatMetrics("replay ×50", "none", {
        durationMs: stabilityMs,
        modelCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      }, `${stabilityReport?.success ?? "?"}/${stabilityReport?.runs ?? "?"} success, ${Math.round((stabilityReport?.fallbackRate ?? 0) * 100)}% fallbacks`),
    ],
    rows: [
      {
        path: "discovery",
        model: disputeDecides.model,
        scenario: "verify-and-file-dispute",
        durationMs: disputeDecides.durationMs,
        modelCalls: disputeDecides.calls,
        estimatedCostUsd: disputeCost,
      },
      {
        path: "discovery",
        model: lookupDecides.model,
        scenario: "lookup-member-savings",
        durationMs: lookupDecides.durationMs,
        modelCalls: lookupDecides.calls,
        estimatedCostUsd: Number(
          costUsd(lookupDecides.model, lookupDecides.calls * EST_IN, lookupDecides.calls * EST_OUT).toFixed(4),
        ),
      },
      {
        path: "replay",
        model: "none",
        scenario: "verify-and-file-dispute",
        durationMs: replayMs,
        modelCalls: 0,
        estimatedCostUsd: 0,
      },
      {
        path: "replay",
        model: "none",
        scenario: "lookup-member-savings",
        durationMs: lookupReplay?.metrics?.durationMs ?? 0,
        modelCalls: 0,
        estimatedCostUsd: 0,
      },
      {
        path: "replay ×50",
        model: "none",
        scenario: "lookup-member-savings",
        durationMs: stabilityMs,
        modelCalls: 0,
        estimatedCostUsd: 0,
        success: stabilityReport?.success,
        runs: stabilityReport?.runs,
        fallbackRate: stabilityReport?.fallbackRate,
      },
    ],
  };
  writeFileSync(resolve(ROOT, "cost-comparison.json"), `${JSON.stringify(costTable, null, 2)}\n`, "utf8");

  writeFileSync(
    resolve(ROOT, "README.md"),
    `# Evidence

Generated against the local Relay Credit Union console.

Through-line: \`discover --id X\` writes \`capabilities/X.json\`; \`replay --capability capabilities/X.json\` loads that same file. Both traces log \`contentHash\` (SHA-256 of the file bytes).

Open \`index.html\` for the catalog (status, code, duration, locator ranks, traces).

| Run | What it shows |
|---|---|
| \`discovery-verify-and-file-dispute/\` | **Impact path.** OpenAI \`gpt-4o\` discovers a teller scenario. Committed live run used a goal that named DSP-1001; the compiled golden now parameterizes merchant + last4 from the Jane Doe goal. Not \`--scripted\`. |
| \`discovery-lookup-member-savings/\` | Observe → **OpenAI \`gpt-4o\`** decide → act on a live Playwright session, then a compiled capability. Not \`--scripted\`. |
| \`discovery-legacy-frameset/\` | Scripted discovery against a real \`<frameset>\` (\`/?legacy=1\`). Observe/act walk every frame. |
| \`discovery-assisted-escalation/\` | Agent mashes Help; a human clicks Search; compiled artifact stamps \`assistedBy\`. |
| \`discovery-assisted-attest/\` | Jane Doe / ACME POS goal. Unfamiliar Supervisor Attestation interstitial → escalate → \`teller01\` clicks I attest on the live session → discovery resumes and compiles \`assistedBy: "teller01"\`. |
| \`rediscover-verify-and-file-dispute/\` | Product loop: replay v1 on westside-drift (rank-3 fallbacks, \`needsRediscovery\`) → scripted re-discover v2 → diff → replay green. |
| \`equivalent-models/\` | Same recording compiled with gpt-4o and claude provenance; step sequences are equivalent. |
| \`replay-lookup-success/\` | Deterministic replay of \`capabilities/lookup-member-savings.json\` with \`memberId=12345\`. No LLM. Same \`contentHash\` as the discovery stamp. Evidence money is \`{ currency: "USD", minor: "[REDACTED]" }\`. |
| \`replay-lookup-not-found/\` | Same capability file, \`memberId=99999\`, classified as \`business_outcome\` / \`MEMBER_NOT_FOUND\`. |
| \`replay-tenant-westside/\` | Same lookup artifact on CU West via \`overlays/tenants/tenant-14.yaml\` (Search → Find Member). Overlay keeps replay green. |
| \`replay-tenant-westside-overlay/\` | \`--tenant westside\`: Find Member, Card Claims, Branch Verification interstitial, field reorder. Same artifact, rank-1 green. |
| \`replay-legacy-hostile/\` | \`?legacy=1\`: frameset, presentation tables, generated ids, duplicate "Savings Balance". Ranked chain falls back; \`needsRediscovery\` fires. |
| \`replay-verify-dispute-already-filed/\` | Second Confirm of DSP-1001 after a real write. Core unique index + UI "Dispute already filed" — not the seeded DSP-1002 fixture. |
| \`replay-drift-rediscovery/\` | Rank-3 text locator on extract → confidence < 1 → \`promoteHits\` v2 → rank-1 green. |
| \`replay-session-expired-reauth/\` | \`?expireMid=1\` kills the session after Search; operator Sign In; replay skips the completed click and extracts. |
| \`replay-ambiguous-row/\` | Last name Doe returns 14 rows; Open is scoped to \`:memberId\` so Jane (12345) is selected. |
| \`policy-blocked-admin-wire/\` | Click **Wire Transfer**; Playwright route layer aborts \`GET /admin/wire\` (\`policy.blocked\` + \`POLICY_VIOLATION\`). |
| \`stability-50/\` | N=50 lookup soak: success rate, fallback rate, p50/p95 duration. |
| \`cost-comparison.json\` | Discovery vs replay cost/latency table. Tokens estimated when logs omit usage; durations are measured. |
| \`escalate-open-sub-account/\` | Risky Confirm: pause, auto-resume. \`operatorKind: "scripted"\`. Sub-account Confirm is a real POST that inserts into \`sub_accounts\`. |
| \`escalate-verify-and-file-dispute/\` | **HITL mechanism.** \`humanCompletesRiskyStep\` takes the lock and clicks Confirm on the live session. The record stamps \`operatorKind: "scripted"\` — timestamps in the hundreds of milliseconds are not a teller. \`filings-proof.json\` is a real \`node:sqlite\` count. |
| \`escalate-verify-and-file-dispute-human/\` | Same scripted waiter plus a stitched \`handoff.gif\` of before/after frames. A genuine headed click is \`RELAY_HEADED=1 npm run escalate-demo -- --capability capabilities/verify-and-file-dispute.json\` with the operator console at :3847; that path stamps \`operatorKind: "human"\`. |
| \`replay-verify-dispute-success/\` | Deterministic replay of \`capabilities/verify-and-file-dispute.json\` for ACME POS / 4412. No LLM. Confirm is approved via \`--approve-risky\`. |
| \`replay-verify-dispute-not-found/\` | Same capability file, \`merchant=NO-SUCH\` / \`last4=0000\`, classified as \`business_outcome\` / \`DISPUTE_NOT_FOUND\`. |
| \`replay-recoverable-notice/\` | \`?notice=1\`: dismiss the System Notice, then **retry the same step**. Status \`success\`. |
| \`replay-hard-failure-locator/\` | Locator miss on extract (\`Savins Balance\`). Status \`failed\` / \`LOCATOR_MISS\` with step id, expected, observed, screenshot. |
| \`replay-needs-human-expired/\` | \`?expired=1\`: session expired. Status \`needs_human\` / \`SESSION_EXPIRED\` — ops ticket, not a locator bug. |
| \`replay-output-empty-amount/\` | DSP-1003: dispute screen loads, amount cell empty (mainframe timeout). Checkpoints pass; typed money output fails \`OUTPUT_INVALID\`. |
| \`replay-recoverable-exhausted/\` | \`?notice=always\`: interstitial returns every time. After the retry cap, \`needs_human\` / \`RECOVERABLE_EXHAUSTED\`. |
| \`replay-batch-reissue-40/\` | 40 block+reissue invokes of \`capabilities/block-and-reissue-card.json\` (4412). Console reset between invokes. Uncapped — runtime.yaml 30/hr would stop this volume run. |
| \`replay-batch-cap-exceeded/\` | 31st invoke against runtime.yaml 30/hr → \`failed\` / \`RATE_LIMIT\`. Console reset before #31 so uniqueness cannot explain a zero write. |
| \`replay-batch-idempotency/\` | Second 4412 reissue; \`card_actions\` SQLite count = 1. |
| \`escalate-batch-business-account/\` | Card 3301: ControlPlane wired → \`escalated\` / \`SUPERVISOR_REQUIRED\`. Without a ControlPlane the same detector is \`needs_human\`. |

The reviewable capabilities live at \`/capabilities/*.json\`. \`discover.artifact\` / \`replay.start\` \`contentHash\` values are SHA-256 of that file. A fresh \`discover --id X\` stamps the hash on \`discover.end\` as well.
`,
  );

  writeEvidenceIndex(ROOT);
  console.log("wrote", resolve(ROOT, "index.html"));
} finally {
  await consoleServer.close();
}
