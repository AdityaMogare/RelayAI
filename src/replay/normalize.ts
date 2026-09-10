import { readFileSync } from "node:fs";
import type { EvidenceEvent, LocatorHit, RunResult } from "../core/types.ts";

/** Honest list of what replay does not pin down. */
export const REPLAY_NON_DETERMINISM = [
  "wall-clock waits (settle timeout and explicit wait steps)",
  "browser rendering timing",
  "the app's case-number generator (this console fixtures CASE-77201; a real core would mint a new case)",
] as const;

export function readJsonl(path: string): EvidenceEvent[] {
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return [];
  return raw.split("\n").map((line) => JSON.parse(line) as EvidenceEvent);
}

/** Strip timestamps, run ids, ports, and filesystem paths so two traces can be byte-compared. */
export function normalizeTrace(events: EvidenceEvent[]): string {
  return `${JSON.stringify(events.map(normalizeEvent), null, 2)}\n`;
}

export function normalizeJsonl(jsonl: string): string {
  const events = jsonl
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as EvidenceEvent);
  return normalizeTrace(events);
}

/**
 * The comparison that proves determinism: same steps, same locators matched, same outputs.
 * Volatile fields (time, ids, ports, paths) are already gone.
 */
export function replayFingerprint(events: EvidenceEvent[], result: RunResult): string {
  const steps = events
    .filter((event) => event.kind === "replay.step" || event.kind === "replay.locator")
    .map((event) => ({ kind: event.kind, data: stripVolatile(event.data) }));
  return `${JSON.stringify({
    status: result.status,
    code: result.code ?? null,
    outputs: result.outputs,
    locators: (result.locatorHits ?? []).map((hit) => fingerprintHit(hit)),
    steps,
  })}\n`;
}

function fingerprintHit(hit: LocatorHit): { stepId: string; rank: number; by: string } {
  return { stepId: hit.stepId, rank: hit.rank, by: hit.by };
}

function normalizeEvent(event: EvidenceEvent): { kind: string; data: unknown } {
  return { kind: event.kind, data: stripVolatile(event.data) };
}

function stripVolatile(value: unknown): unknown {
  const json = JSON.stringify(value, (_key, item) => item);
  if (!json) return value;
  const stripped = json
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.+-]+Z?/g, "<ts>")
    .replace(/https?:\/\/127\.0\.0\.1:\d+/g, "http://127.0.0.1:<port>")
    .replace(/https?:\/\/localhost:\d+/g, "http://localhost:<port>")
    .replace(/\/[A-Za-z0-9_./-]*evidence[A-Za-z0-9_./-]*/g, "<evidence>")
    .replace(/\/[A-Za-z0-9_./-]*relay-[A-Za-z0-9_./-]*/g, "<tmp>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>");
  return JSON.parse(stripped);
}
