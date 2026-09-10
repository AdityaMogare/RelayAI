import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DiscoveryAgent } from "./discover.ts";
import { createLlmClient, ScriptedLlm } from "./providers.ts";
import { JANE_DOE_DISPUTE_GOAL, scriptedWestsideFileByMerchant } from "./scripts.ts";
import { diffSteps } from "../artifact/equivalent.ts";
import { FileArtifactStore } from "../artifact/store.ts";
import type { Capability } from "../core/types.ts";
import { EvidenceStore, newRunId } from "../evidence/store.ts";
import { ControlPlane, immediateResume } from "../escalation/control.ts";
import { bindTenant } from "../overlay/store.ts";
import { ReplayEngine } from "../replay/engine.ts";
import { WebSurface } from "../surfaces/web.ts";

export type RediscoverReport = {
  capabilityId: string;
  tenantId: string;
  v1Path: string;
  v2Path: string;
  replayV1: { status: string; confidence?: number; needsRediscovery?: boolean };
  replayV2?: { status: string; confidence?: number; needsRediscovery?: boolean };
  diff: ReturnType<typeof diffSteps>;
  evidence: string;
};

export async function rediscover(input: {
  capability: Capability;
  capabilityPath: string;
  tenantId: string;
  baseUrl: string;
  scripted?: boolean;
  headed?: boolean;
  goal?: string;
}): Promise<RediscoverReport> {
  const v1 = input.capability;
  const runId = newRunId(`rediscover-${v1.id}`);
  const evidence = new EvidenceStore(runId);
  const surface = new WebSurface({ headed: Boolean(input.headed) });
  await surface.launch();
  const store = new FileArtifactStore(resolve(evidence.dir));
  const llm = input.scripted
    ? new ScriptedLlm(scriptedWestsideFileByMerchant())
    : createLlmClient();
  const agent = new DiscoveryAgent(
    surface,
    llm,
    store,
    evidence,
  );
  const control = new ControlPlane(surface, evidence, immediateResume("auto-resume"));
  try {
    const bound = bindTenant(v1, input.tenantId, { baseUrl: input.baseUrl, tenantId: input.tenantId });
    const driftReplay = await new ReplayEngine(surface, evidence).run(bound.capability, {
      inputs: defaultInputs(v1),
      approveRisky: true,
      baseUrl: input.baseUrl,
      tenantId: input.tenantId,
      catalog: new FileArtifactStore(),
    });

    const discovered = await agent.run({
      goal: input.goal ?? v1.provenance.goal ?? v1.description,
      targetUrl: input.baseUrl,
      capabilityId: v1.id,
      version: v1.version + 1,
      maxSteps: 20,
      control,
    });
    if (!discovered.artifact || !discovered.artifactPath) {
      throw new Error(discovered.result.message ?? "re-discovery did not compile an artifact");
    }
    const v2 = discovered.artifact;
    v2.version = v1.version + 1;
    writeFileSync(discovered.artifactPath, `${JSON.stringify(v2, null, 2)}\n`);

    const v2Replay = await new ReplayEngine(surface, new EvidenceStore(`${runId}-v2`)).run(v2, {
      inputs: defaultInputs(v2),
      approveRisky: true,
      baseUrl: input.baseUrl,
      tenantId: input.tenantId,
    });

    const report: RediscoverReport = {
      capabilityId: v1.id,
      tenantId: input.tenantId,
      v1Path: input.capabilityPath,
      v2Path: discovered.artifactPath,
      replayV1: {
        status: driftReplay.status,
        confidence: driftReplay.confidence,
        needsRediscovery: driftReplay.needsRediscovery,
      },
      replayV2: {
        status: v2Replay.status,
        confidence: v2Replay.confidence,
        needsRediscovery: v2Replay.needsRediscovery,
      },
      diff: diffSteps(v1, v2),
      evidence: evidence.dir,
    };
    mkdirSync(evidence.dir, { recursive: true });
    writeFileSync(resolve(evidence.dir, "diff.json"), `${JSON.stringify(report, null, 2)}\n`);
    return report;
  } finally {
    await surface.close();
  }
}

function defaultInputs(capability: Capability): Record<string, string> {
  const defaults: Record<string, string> = {
    memberId: "Jane Doe",
    merchant: "ACME POS",
    last4: "4412",
    reason: "Unauthorized",
  };
  const inputs: Record<string, string> = {};
  for (const param of capability.parameters) {
    if (defaults[param.name]) inputs[param.name] = defaults[param.name]!;
  }
  return inputs;
}

export { JANE_DOE_DISPUTE_GOAL };
