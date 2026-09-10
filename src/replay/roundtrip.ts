import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiscoveryAgent } from "../agent/discover.ts";
import { ScriptedLlm } from "../agent/providers.ts";
import { scriptedLookup } from "../agent/scripts.ts";
import { FileArtifactStore } from "../artifact/store.ts";
import type { Capability, RunResult } from "../core/types.ts";
import { EvidenceStore } from "../evidence/store.ts";
import { MockSurface } from "../surfaces/mock.ts";
import { ReplayEngine } from "./engine.ts";
import { readJsonl, replayFingerprint } from "./normalize.ts";

export type RoundTripProof = {
  artifactPath: string;
  discoverHash: string;
  replayHash: string;
  matched: boolean;
  result: RunResult;
  discoverLog: string;
  replayLog: string;
};

export async function scriptedRoundTrip(root = mkdtempSync(join(tmpdir(), "relay-roundtrip-"))): Promise<RoundTripProof> {
  const capDir = join(root, "capabilities");
  const store = new FileArtifactStore(capDir);
  const discoverEvidence = new EvidenceStore("roundtrip-discover", join(root, "discover"));
  const agent = new DiscoveryAgent(new MockSurface(), new ScriptedLlm(scriptedLookup()), store, discoverEvidence);
  const discovered = await agent.run({
    goal: "Look up member 12345 and read their current savings balance",
    targetUrl: "http://127.0.0.1:3000/",
    capabilityId: "lookup-member-savings",
  });
  if (!discovered.artifactPath) throw new Error("Discovery did not write an artifact.");
  const { capability, path, contentHash } = await store.loadWithHash(discovered.artifactPath);
  const replayEvidence = new EvidenceStore("roundtrip-replay", join(root, "replay"));
  const result = await new ReplayEngine(new MockSurface(), replayEvidence).run(capability, {
    inputs: { memberId: "12345" },
    artifactPath: path,
    contentHash,
  });
  const discoverLog = join(discoverEvidence.dir, "log.jsonl");
  const replayLog = join(replayEvidence.dir, "log.jsonl");
  const discoverHash = hashFromLog(discoverLog, "discover.end");
  const replayHash = hashFromLog(replayLog, "replay.start");
  return {
    artifactPath: path,
    discoverHash,
    replayHash,
    matched: Boolean(discoverHash) && discoverHash === replayHash,
    result,
    discoverLog,
    replayLog,
  };
}

export async function doubleRunFingerprints(
  capability: Capability,
  inputs: Record<string, string>,
  extra: { approveRisky?: boolean } = {},
): Promise<{ a: string; b: string; resultA: RunResult; resultB: RunResult }> {
  const runOnce = async (label: string) => {
    const evidence = new EvidenceStore(label, mkdtempSync(join(tmpdir(), "relay-det-")));
    const result = await new ReplayEngine(new MockSurface(), evidence).run(capability, {
      inputs,
      approveRisky: extra.approveRisky,
    });
    const events = readJsonl(join(evidence.dir, "log.jsonl"));
    return { result, fingerprint: replayFingerprint(events, result) };
  };
  const first = await runOnce("det-a");
  const second = await runOnce("det-b");
  return { a: first.fingerprint, b: second.fingerprint, resultA: first.result, resultB: second.result };
}

export function hashFromLog(logPath: string, kind: string): string {
  const events = readJsonl(logPath);
  const event = events.find((row) => row.kind === kind);
  const hash = event?.data.contentHash;
  if (typeof hash !== "string" || hash.length !== 64) {
    throw new Error(`No contentHash on ${kind} in ${logPath}`);
  }
  return hash;
}
