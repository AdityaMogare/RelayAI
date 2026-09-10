import "dotenv/config";
import { Command, CommanderError } from "commander";
import { DiscoveryAgent } from "./agent/discover.ts";
import { createLlmClient, ScriptedLlm } from "./agent/providers.ts";
import { rediscover } from "./agent/rediscover.ts";
import { scriptedFileByMerchant, scriptedLookup } from "./agent/scripts.ts";
import { approveCapability, assertTwoPersonApproval, reviewCapability } from "./artifact/review.ts";
import { FileArtifactStore } from "./artifact/store.ts";
import { capabilityToTool } from "./artifact/tools.ts";
import { CliUsageError, errorPayload } from "./core/errors.ts";
import { ControlPlane, immediateResume } from "./escalation/control.ts";
import { createOperatorWaiter } from "./escalation/operator.ts";
import { purgeEvidence } from "./evidence/purge.ts";
import { EvidenceStore, newRunId } from "./evidence/store.ts";
import { OVERLAY_ORDER_DIAGRAM, describeConfirmFix } from "./overlay/resolve.ts";
import { bindTenant } from "./overlay/store.ts";
import { FileInvocationStore, loadRuntime, RateLimiter, saveRuntime } from "./policy/runtime.ts";
import { EnvVault } from "./policy/vault.ts";
import { ReplayEngine } from "./replay/engine.ts";
import { FileRunLedger, queryAudit, readLedgerFile } from "./replay/ledger.ts";
import { driftScore } from "./replay/drift.ts";
import { probeApplicability } from "./replay/probe.ts";
import { formatPortability, runPortability } from "./replay/portability.ts";
import { runStability } from "./replay/stability.ts";
import { runVerify } from "./verify.ts";
import { DesktopSurface } from "./surfaces/desktop.ts";
import { WebSurface } from "./surfaces/web.ts";
import { startConsole } from "../apps/bank-console/server.ts";
import { CU_WEST_SKIN, WESTSIDE_DRIFT_SKIN, WESTSIDE_SKIN, type ConsoleSkin } from "../apps/bank-console/skins.ts";

function jsonRequested(): boolean {
  return process.argv.includes("--json");
}

function jsonFlag(cmd: Command): Command {
  return cmd.option("--json", "Write a JSON object to stdout (agent-invocable)");
}

function printJson(result: unknown): void {
  console.log(JSON.stringify(result, null, 2));
}

function emit(opts: { json?: boolean }, payload: unknown, human?: string): void {
  if (opts.json || program.opts().json || jsonRequested() || human === undefined) {
    printJson(payload);
    return;
  }
  process.stdout.write(human);
}

async function loadCapability(idOrPath: string) {
  return new FileArtifactStore().loadWithHash(idOrPath);
}

function parseInputs(values: string[]): Record<string, string> {
  const inputs: Record<string, string> = {};
  for (const value of values) {
    const idx = value.indexOf("=");
    if (idx === -1) throw new CliUsageError(`Expected key=value, got ${value}`);
    inputs[value.slice(0, idx)] = value.slice(idx + 1);
  }
  return inputs;
}

function headed(): boolean {
  return process.env.RELAY_HEADED === "1" || process.env.RELAY_HEADED === "true";
}

function skinForTenant(tenant: string | undefined): ConsoleSkin | undefined {
  if (tenant === "tenant-14") return CU_WEST_SKIN;
  if (tenant === "westside-drift") return WESTSIDE_DRIFT_SKIN;
  if (tenant === "westside") return WESTSIDE_SKIN;
  return undefined;
}

const program = new Command();
program.exitOverride();
program.name("relayai").description("Discover once with an LLM, replay forever without one.");
program.option("--json", "Write a JSON object to stdout (agent-invocable)");

jsonFlag(
  program
    .command("discover")
    .requiredOption("--goal <text>", "Natural-language goal")
    .requiredOption("--target <url>", "Entry URL of the target app")
    .option("--id <id>", "Capability id to write")
    .option("--max-steps <n>", "Max observe/decide/act iterations", "12")
    .option("--headed", "Show the browser")
    .option("--scripted", "Use a built-in scripted policy (no LLM) for offline demos")
    .option("--provider <name>", "openai | anthropic")
    .option("--model <id>", "Model id (gpt-4o, claude-sonnet-4-20250514, …)"),
).action(async (opts) => {
  const runId = newRunId("discovery");
  const evidence = new EvidenceStore(runId);
  const surface = new WebSurface({ headed: Boolean(opts.headed) || headed() });
  await surface.launch();
  const store = new FileArtifactStore();
  const llm = opts.scripted
    ? new ScriptedLlm(/ACME|Jane Doe/i.test(String(opts.goal)) ? scriptedFileByMerchant() : scriptedLookup())
    : createLlmClient({ provider: opts.provider, model: opts.model });
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
    emit(opts, { ...out.result, artifactPath: out.artifactPath, evidence: evidence.dir });
    if (out.result.status === "failed") process.exitCode = 1;
  } finally {
    await surface.close();
  }
});

jsonFlag(
  program
    .command("replay")
    .requiredOption("--capability <idOrPath>", "Capability id or JSON path")
    .option("--input <key=value>", "Typed parameter", (v, acc: string[]) => [...acc, v], [] as string[])
    .option("--base-url <url>", "Override artifact host (ephemeral console ports)")
    .option("--approve-risky", "Allow irreversible steps without a human")
    .option("--dry-run", "Execute until irreversible steps, then report what would happen")
    .option("--tenant <id>", "Tenant overlay + kill switch + blast-radius", "tenant-9")
    .option("--probe", "Read-only entry-screen check before the first act")
    .option("--headed", "Show the browser"),
).action(async (opts) => {
  const { capability, path, contentHash } = await loadCapability(opts.capability);
  const started = opts.baseUrl ? undefined : skinForTenant(opts.tenant) ? await startConsole(0, { skin: skinForTenant(opts.tenant) }) : undefined;
  const baseUrl = started?.origin ?? opts.baseUrl;
  const bound = bindTenant(capability, opts.tenant, { baseUrl, tenantId: opts.tenant });
  const runId = newRunId(`replay-${capability.id}`);
  const evidence = new EvidenceStore(runId);
  const surface = new WebSurface({ headed: Boolean(opts.headed) || headed() });
  await surface.launch();
  const store = new FileArtifactStore();
  const ledger = new FileRunLedger();
  const engine = new ReplayEngine(surface, evidence);
  try {
    const result = await engine.run(bound.capability, {
      inputs: parseInputs(opts.input),
      approveRisky: Boolean(opts.approveRisky),
      dryRun: Boolean(opts.dryRun),
      baseUrl: bound.trace.baseUrl ?? baseUrl,
      artifactPath: path,
      contentHash,
      ledger,
      catalog: store,
      tenantId: opts.tenant,
      vault: new EnvVault(),
      limiter: new RateLimiter(new FileInvocationStore()),
      probe: Boolean(opts.probe),
      overlayTrace: bound.trace,
    });
    emit(opts, { ...result, evidence: evidence.dir, overlay: bound.trace.copy, metrics: result.metrics });
    if (result.status === "failed" || result.status === "invalid_input" || result.status === "needs_human") {
      process.exitCode = 1;
    }
    if (result.needsRediscovery) process.exitCode = 1;
  } finally {
    await surface.close();
    await started?.close();
  }
});

jsonFlag(
  program
    .command("rediscover")
    .description("Replay on a drifted tenant, then discover v2, diff, and replay green")
    .requiredOption("--capability <idOrPath>", "Capability id or JSON path")
    .option("--tenant <id>", "Tenant to re-record against", "westside-drift")
    .option("--base-url <url>", "Override host")
    .option("--scripted", "Offline scripted re-discovery")
    .option("--headed", "Show the browser"),
).action(async (opts) => {
  const loaded = await loadCapability(opts.capability);
  const started = opts.baseUrl ? undefined : await startConsole(0, { skin: skinForTenant(opts.tenant) ?? WESTSIDE_DRIFT_SKIN });
  const baseUrl = opts.baseUrl ?? started?.origin ?? "http://127.0.0.1:3000";
  try {
    const report = await rediscover({
      capability: loaded.capability,
      capabilityPath: loaded.path,
      tenantId: opts.tenant,
      baseUrl,
      scripted: Boolean(opts.scripted),
      headed: Boolean(opts.headed) || headed(),
    });
    emit(
      opts,
      report,
      `v1 replay  confidence ${report.replayV1.confidence ?? "?"}  needsRediscovery=${report.replayV1.needsRediscovery}\nv2 ${report.v2Path}\n${report.diff.length} step diffs\nv2 replay  ${report.replayV2?.status}  confidence ${report.replayV2?.confidence ?? "?"}\n`,
    );
    if (report.replayV2?.status !== "success") process.exitCode = 1;
  } finally {
    await started?.close();
  }
});

jsonFlag(
  program
    .command("escalate-demo")
    .option("--base-url <url>", "Console origin", "http://127.0.0.1:3000")
    .option("--capability <idOrPath>", "Capability to pause on Confirm", "capabilities/open-sub-account.json")
    .option("--auto-resume-ms <n>", "Resume automatically after N ms (for evidence)"),
).action(async (opts) => {
  const { capability, path, contentHash } = await loadCapability(opts.capability);
  const runId = newRunId("escalate-demo");
  const evidence = new EvidenceStore(runId);
  const surface = new WebSurface({ headed: true });
  await surface.launch();
  const autoResumeMs = Number(opts.autoResumeMs ?? process.env.RELAY_AUTO_RESUME_MS ?? 0);
  const waiter = autoResumeMs > 0 ? createOperatorWaiter({ autoResumeMs }) : createOperatorWaiter({});
  const control = new ControlPlane(surface, evidence, waiter);
  const engine = new ReplayEngine(surface, evidence);
  try {
    const result = await engine.run(capability, {
      inputs: capability.id.includes("dispute")
        ? { memberId: "12345", merchant: "ACME POS", last4: "4412", reason: "Unauthorized" }
        : { memberId: "12345", product: "Share Savings" },
      approveRisky: false,
      baseUrl: opts.baseUrl,
      control,
      artifactPath: path,
      contentHash,
      ledger: new FileRunLedger(),
      catalog: new FileArtifactStore(),
    });
    emit(opts, { ...result, evidence: evidence.dir, intervention: control.lastIntervention });
  } finally {
    await surface.close();
  }
});

jsonFlag(
  program
    .command("capabilities")
    .description("List or invoke saved capabilities (agent-facing catalog)")
    .argument("[action]", "list | invoke | tools", "list")
    .option("--id <id>", "Capability id")
    .option("--input <key=value>", "Typed parameter", (v, acc: string[]) => [...acc, v], [] as string[])
    .option("--base-url <url>", "Override host")
    .option("--tenant <id>", "Tenant overlay + kill switch + blast-radius", "tenant-9")
    .option("--approve-risky"),
).action(async (action, opts) => {
  const store = new FileArtifactStore();
  if (action === "tools") {
    const items = opts.id ? [await store.load(opts.id)] : await store.list();
    const tools = items.map(capabilityToTool);
    emit(
      opts,
      { tools, invoke: "npm run capabilities -- invoke --id lookup-member-savings --input memberId=12345" },
      `${JSON.stringify(tools, null, 2)}\n\nInvoke by name:\n  npm run capabilities -- invoke --id lookup-member-savings --input memberId=12345\n`,
    );
    return;
  }
  if (action !== "invoke") {
    const items = await store.list();
    emit(
      opts,
      items.map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        parameters: c.parameters,
        outputs: c.outputs.map((o) => ({ name: o.name, type: o.type, pii: o.pii })),
        sideEffects: c.sideEffects,
        preconditions: c.preconditions,
        uses: c.uses,
        provenance: c.provenance,
        auth: c.auth,
      })),
    );
    return;
  }
  if (!opts.id) throw new CliUsageError("--id is required for invoke");
  const { capability, path, contentHash } = await store.loadWithHash(opts.id);
  const bound = bindTenant(capability, opts.tenant, { baseUrl: opts.baseUrl, tenantId: opts.tenant });
  const evidence = new EvidenceStore(newRunId(`invoke-${capability.id}`));
  const surface = new WebSurface({ headed: headed() });
  await surface.launch();
  try {
    const result = await new ReplayEngine(surface, evidence).run(bound.capability, {
      inputs: parseInputs(opts.input),
      approveRisky: Boolean(opts.approveRisky),
      baseUrl: bound.trace.baseUrl ?? opts.baseUrl,
      artifactPath: path,
      contentHash,
      ledger: new FileRunLedger(),
      catalog: store,
      tenantId: opts.tenant,
      vault: new EnvVault(),
      limiter: new RateLimiter(new FileInvocationStore()),
      overlayTrace: bound.trace,
    });
    emit(opts, result);
  } finally {
    await surface.close();
  }
});

jsonFlag(
  program
    .command("stability")
    .description("Replay a capability N times and report a reliability signal")
    .requiredOption("--capability <idOrPath>", "Capability id or JSON path")
    .option("--input <key=value>", "Typed parameter", (v, acc: string[]) => [...acc, v], [] as string[])
    .option("--runs <n>", "Number of sequential replays", "5")
    .option("--base-url <url>", "Override artifact host")
    .option("--approve-risky", "Allow irreversible steps without a human")
    .option("--headed", "Show the browser"),
).action(async (opts) => {
  const { capability, path, contentHash } = await loadCapability(opts.capability);
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
      artifactPath: path,
      contentHash,
    });
    emit(opts, report);
    if (report.failed > 0) process.exitCode = 1;
  } finally {
    await surface.close();
    await started?.close();
  }
});

jsonFlag(
  program.command("verify").description("Run every scenario and print a green/red table. Hash through-line included."),
).action(async (opts) => {
  const report = await runVerify();
  emit(opts, { ok: report.ok, passed: report.passed, failed: report.failed, rows: report.rows }, report.text);
  if (!report.ok) process.exitCode = 1;
});

jsonFlag(
  program
    .command("review")
    .description("Approval-time diff: irreversible controls marked safe fail the gate")
    .option("--capability <idOrPath>", "Review one capability (default: all in /capabilities)"),
).action(async (opts) => {
  const store = new FileArtifactStore();
  const caps = opts.capability ? [await store.load(opts.capability)] : await store.list();
  const reports = caps.map((capability) => {
    const findings = reviewCapability(capability);
    let approvalError: string | undefined;
    try {
      assertTwoPersonApproval(capability);
    } catch (err) {
      approvalError = err instanceof Error ? err.message : String(err);
    }
    return {
      id: capability.id,
      findings,
      approvalError,
      ok: findings.length === 0 && !approvalError,
    };
  });
  const failed = reports.filter((r) => !r.ok);
  emit(
    opts,
    { ok: failed.length === 0, reports },
    reports
      .map((r) => {
        if (r.ok) return `${r.id}: ok\n`;
        const lines = r.findings.map((f) => `  ${f.stepId}: ${f.issue}`);
        if (r.approvalError) lines.push(`  ${r.approvalError}`);
        return `${r.id}: REVIEW\n${lines.join("\n")}\n`;
      })
      .join(""),
  );
  if (failed.length > 0) process.exitCode = 1;
});

jsonFlag(
  program
    .command("approve")
    .description("Two-person stamp: requestedBy must differ from approvedBy")
    .requiredOption("--capability <idOrPath>", "Capability id or JSON path")
    .requiredOption("--requested-by <email>", "Requester identity")
    .requiredOption("--approved-by <email>", "Approver identity (must differ)"),
).action(async (opts) => {
  const store = new FileArtifactStore();
  const { capability } = await store.loadWithHash(opts.capability);
  const next = approveCapability(capability, {
    requestedBy: opts.requestedBy,
    approvedBy: opts.approvedBy,
  });
  const saved = await store.save(next);
  emit(opts, { ok: true, path: saved, approval: next.approval }, `Approved ${next.id} at ${saved}\n`);
});

jsonFlag(
  program
    .command("kill")
    .description("Disable a capability or tenant without a deploy (edits policy/runtime.yaml)")
    .option("--capability <id>", "Capability id to disable")
    .option("--tenant <id>", "Tenant id to disable")
    .option("--clear", "Re-enable everything"),
).action(async (opts) => {
  if (!opts.clear && !opts.capability && !opts.tenant) {
    throw new CliUsageError("Pass --capability, --tenant, or --clear.");
  }
  const runtime = loadRuntime();
  if (opts.clear) {
    runtime.disabled.capabilities = [];
    runtime.disabled.tenants = [];
  }
  if (opts.capability && !runtime.disabled.capabilities.includes(opts.capability)) {
    runtime.disabled.capabilities.push(opts.capability);
  }
  if (opts.tenant && !runtime.disabled.tenants.includes(opts.tenant)) {
    runtime.disabled.tenants.push(opts.tenant);
  }
  saveRuntime(runtime);
  emit(
    opts,
    { ok: true, disabled: runtime.disabled, retentionDays: runtime.retention.ttlDays },
    `Kill switch written. capabilities=${JSON.stringify(runtime.disabled.capabilities)} tenants=${JSON.stringify(runtime.disabled.tenants)}\n`,
  );
});

jsonFlag(
  program
    .command("audit")
    .description("What did this automation touch for a member in a time window?")
    .option("--member <id>", "Member id")
    .option("--tenant <id>", "Tenant id")
    .option("--from <iso>", "Inclusive start (ISO date or datetime)")
    .option("--to <iso>", "Inclusive end (ISO date or datetime)"),
).action(async (opts) => {
  const hits = queryAudit(readLedgerFile(), {
    memberId: opts.member,
    tenantId: opts.tenant,
    from: opts.from,
    to: opts.to,
  });
  emit(
    opts,
    { count: hits.length, entries: hits },
    hits.length === 0
      ? "No matching ledger entries.\n"
      : hits
          .map(
            (e) =>
              `${e.at} ${e.capabilityId} ${e.status} member=${e.memberId ?? "-"} tenant=${e.tenantId ?? "-"} routes=${(e.routes ?? []).join(",") || "-"} credentialRef=${e.credentialRef ?? "-"}\n`,
          )
          .join(""),
  );
});

jsonFlag(
  program
    .command("probe")
    .description("Read-only: does this tenant's entry screen match the capability?")
    .requiredOption("--capability <idOrPath>", "Capability id or JSON path")
    .option("--tenant <id>", "Tenant overlay to apply", "tenant-9")
    .option("--base-url <url>", "Override artifact host")
    .option("--input <key=value>", "Typed parameter (for :memberId URLs)", (v, acc: string[]) => [...acc, v], [] as string[])
    .option("--headed", "Show the browser"),
).action(async (opts) => {
  const { capability } = await loadCapability(opts.capability);
  const bound = bindTenant(capability, opts.tenant, { baseUrl: opts.baseUrl, tenantId: opts.tenant });
    const started = opts.baseUrl ? undefined : await startConsole(0, opts.tenant === "tenant-14" || opts.tenant === "westside" || opts.tenant === "westside-drift" ? { skin: skinForTenant(opts.tenant) } : {});
  const baseUrl = bound.trace.baseUrl ?? opts.baseUrl ?? started?.origin;
  const surface = new WebSurface({ headed: Boolean(opts.headed) || headed() });
  await surface.launch();
  try {
    const result = await probeApplicability(surface, bound.capability, {
      baseUrl,
      inputs: parseInputs(opts.input),
    });
    emit(opts, result, `${result.applicable ? "applicable" : "NOT applicable"} — ${result.reason}\n`);
    if (!result.applicable) process.exitCode = 1;
  } finally {
    await surface.close();
    await started?.close();
  }
});

jsonFlag(
  program
    .command("overlay")
    .description("Print overlay resolution (base → vendor → tenant → run) for a capability")
    .requiredOption("--capability <idOrPath>", "Capability id or JSON path")
    .option("--tenant <id>", "Tenant overlay", "tenant-14"),
).action(async (opts) => {
  const { capability } = await loadCapability(opts.capability);
  const bound = bindTenant(capability, opts.tenant, { tenantId: opts.tenant });
  const confirm = describeConfirmFix(bound.trace);
  const copyLines = Object.entries(bound.trace.copy)
    .map(([from, to]) => `  ${from} → ${to}`)
    .join("\n");
  emit(
    opts,
    { diagram: OVERLAY_ORDER_DIAGRAM, trace: bound.trace, confirm },
    `Resolution order (later wins):\n${OVERLAY_ORDER_DIAGRAM}\n\nForbidden to overlays: risk, steps, sideEffects, id, vendorId\n\n${opts.tenant} copy:\n${copyLines || "  (none — recorded names)"}\n${
      confirm ? `\nSmallest change for Confirm → ${confirm.change}\n  file: ${confirm.file}\n  who:  ${confirm.who}\n` : ""
    }`,
  );
});

jsonFlag(
  program
    .command("drift")
    .description("Fallback-locator + checkpoint-miss rate for a tenant over the last N runs")
    .option("--tenant <id>", "Tenant id", "tenant-9")
    .option("--capability <id>", "Limit to one capability")
    .option("--window <n>", "Last N ledger rows", "20"),
).action(async (opts) => {
  const report = driftScore(readLedgerFile(), {
    tenantId: opts.tenant,
    capabilityId: opts.capability,
    window: Math.max(1, Number(opts.window)),
  });
  emit(opts, report, `${report.reason}\n`);
  if (report.needsRediscovery) process.exitCode = 1;
});

jsonFlag(
  program
    .command("portability")
    .description("Run one artifact against tenant-9, tenant-14, and westside; print match / fallback / overlay")
    .option("--capability <idOrPath>", "Capability id or JSON path", "capabilities/lookup-member-savings.json")
    .option("--input <key=value>", "Typed parameter", (v, acc: string[]) => [...acc, v], [] as string[])
    .option("--headed", "Show the browser"),
).action(async (opts) => {
  const { capability } = await loadCapability(opts.capability);
  const inputs = Object.keys(parseInputs(opts.input)).length ? parseInputs(opts.input) : { memberId: "12345" };
  const a = await startConsole(0);
  const b = await startConsole(0, { skin: CU_WEST_SKIN });
  const c = await startConsole(0, { skin: WESTSIDE_SKIN });
  const surfaceA = new WebSurface({ headed: Boolean(opts.headed) || headed() });
  const surfaceB = new WebSurface({ headed: Boolean(opts.headed) || headed() });
  const surfaceC = new WebSurface({ headed: Boolean(opts.headed) || headed() });
  await surfaceA.launch();
  await surfaceB.launch();
  await surfaceC.launch();
  try {
    const report = await runPortability({
      capability,
      tenants: [
        {
          tenantId: "tenant-9",
          resolved: bindTenant(capability, "tenant-9", { baseUrl: a.origin, tenantId: "tenant-9" }),
          surface: surfaceA,
          inputs,
          baseUrl: a.origin,
        },
        {
          tenantId: "tenant-14",
          resolved: bindTenant(capability, "tenant-14", { baseUrl: b.origin, tenantId: "tenant-14" }),
          surface: surfaceB,
          inputs,
          baseUrl: b.origin,
        },
        {
          tenantId: "westside",
          resolved: bindTenant(capability, "westside", { baseUrl: c.origin, tenantId: "westside" }),
          surface: surfaceC,
          inputs,
          baseUrl: c.origin,
        },
      ],
    });
    emit(opts, report, formatPortability(report));
    if (report.tenants.some((t) => t.result.status !== "success" || !t.probe.applicable)) process.exitCode = 1;
  } finally {
    await surfaceA.close();
    await surfaceB.close();
    await surfaceC.close();
    await a.close();
    await b.close();
    await c.close();
  }
});

jsonFlag(
  program
    .command("desktop-replay")
    .description("Replay lookup against the desktop Surface (fake accessibility tree, no Playwright)")
    .option("--input <key=value>", "Typed parameter", (v, acc: string[]) => [...acc, v], [] as string[]),
).action(async (opts) => {
  const { capability, path, contentHash } = await loadCapability("capabilities/lookup-member-savings.json");
  const evidence = new EvidenceStore(newRunId("desktop-lookup"));
  const result = await new ReplayEngine(new DesktopSurface(), evidence).run(capability, {
    inputs: Object.keys(parseInputs(opts.input)).length ? parseInputs(opts.input) : { memberId: "12345" },
    artifactPath: path,
    contentHash,
  });
  emit(opts, { ...result, evidence: evidence.dir, surface: "desktop" });
  if (result.status === "failed") process.exitCode = 1;
});

jsonFlag(
  program.command("evidence-purge")
    .description("Delete evidence older than the retention TTL (14 days)"),
).action(async (opts) => {
  const result = purgeEvidence();
  emit(
    opts,
    result,
    `TTL ${result.ttlDays} days. Deleted ${result.deleted.length}. Kept ${result.kept.length}.\n`,
  );
});

try {
  await program.parseAsync(process.argv);
} catch (err) {
  if (err instanceof CommanderError && (err.code === "commander.helpDisplayed" || err.code === "commander.version")) {
    process.exitCode = err.exitCode;
  } else {
    const payload = errorPayload(err);
    if (jsonRequested()) printJson(payload);
    else console.error(payload.error.message);
    process.exitCode = err instanceof CommanderError ? err.exitCode || 1 : 1;
  }
}
