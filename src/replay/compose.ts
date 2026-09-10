import type { ArtifactStore } from "../artifact/store.ts";
import { FileArtifactStore } from "../artifact/store.ts";
import type { Capability, LocatorHit, Observation, OutputValue, RunResult } from "../core/types.ts";
import type { EvidenceStore } from "../evidence/store.ts";
import { bindTenant } from "../overlay/store.ts";
import type { ReplayOptions } from "./options.ts";

export async function loadUsed(id: string, catalog?: ArtifactStore, tenantId?: string): Promise<Capability> {
  const store = catalog ?? new FileArtifactStore();
  const child = await store.load(id);
  if (!tenantId) return child;
  return bindTenant(child, tenantId).capability;
}

export async function runUsed(opts: {
  use: Capability["uses"][number];
  parent: Capability;
  options: ReplayOptions;
  outputs: Record<string, OutputValue>;
  hits: LocatorHit[];
  seen: string[];
  evidence: EvidenceStore;
  observe: () => Promise<Observation>;
  checkpointHolds: (checkpoint: Capability["success"]["checkpoint"], observed: Observation) => boolean;
  run: (capability: Capability, options: ReplayOptions) => Promise<RunResult>;
  currentAudit?: { routes: string[] };
  getAudit: () => { routes: string[] } | undefined;
  setAudit: (audit: { routes: string[] } | undefined) => void;
  currentLedger: ReplayOptions["ledger"];
  setLedger: (ledger: ReplayOptions["ledger"]) => void;
}): Promise<RunResult | undefined> {
  const child = await loadUsed(opts.use.capabilityId, opts.options.catalog, opts.options.tenantId);
  const observed = await opts.observe();
  if (opts.checkpointHolds(child.success.checkpoint, observed)) {
    opts.evidence.event("replay.compose.skip", {
      parentId: opts.parent.id,
      capabilityId: child.id,
      reason: "success checkpoint already holds on the surface",
    });
    return undefined;
  }
  const childInputs: Record<string, string> = {};
  for (const name of opts.use.pass) {
    const value = opts.options.inputs[name];
    if (value !== undefined) childInputs[name] = value;
  }
  opts.evidence.event("replay.compose", { parentId: opts.parent.id, capabilityId: child.id, pass: opts.use.pass });
  const savedAudit = opts.currentAudit;
  const savedLedger = opts.currentLedger;
  const childResult = await opts.run(child, {
    ...opts.options,
    inputs: childInputs,
    bag: opts.outputs,
    nested: true,
    seen: opts.seen,
    artifactPath: undefined,
  });
  const afterAudit = opts.getAudit();
  if (savedAudit && afterAudit) {
    for (const route of afterAudit.routes) {
      if (!savedAudit.routes.includes(route)) savedAudit.routes.push(route);
    }
  }
  opts.setAudit(savedAudit);
  opts.setLedger(savedLedger);
  if (childResult.status !== "success") return childResult;
  Object.assign(opts.outputs, childResult.outputs ?? {});
  opts.hits.push(...(childResult.locatorHits ?? []));
  return undefined;
}
