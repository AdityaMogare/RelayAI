export type LogEvent = { at?: string; kind?: string; data?: { model?: string } };

export function parseJsonl(raw: string): LogEvent[] {
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as LogEvent);
}

/** Wall-clock from the first event to the last event of `stopKind`. Later stamp lines do not count. */
export function wallClockUntil(events: LogEvent[], stopKind: string): number {
  let first = 0;
  let stop = 0;
  for (const event of events) {
    const at = event.at ? Date.parse(event.at) : 0;
    if (!at) continue;
    if (!first) first = at;
    if (event.kind === stopKind) stop = at;
  }
  if (!first || !stop) return 0;
  return Math.max(0, stop - first);
}

export function countDiscovers(events: LogEvent[]): { model: string; calls: number; durationMs: number } {
  let calls = 0;
  let model = "unknown";
  for (const event of events) {
    if (event.kind === "discover.decide") {
      calls += 1;
      if (event.data?.model) model = event.data.model;
    }
  }
  return { model, calls, durationMs: wallClockUntil(events, "discover.end") };
}
