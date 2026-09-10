import { expandParams } from "../artifact/canonical.ts";
import type { Checkpoint, Observation } from "../core/types.ts";

export function checkpointHolds(
  checkpoint: Checkpoint,
  observed: Observation,
  inputs: Record<string, string>,
): boolean {
  const expect = expandParams(checkpoint.expect, inputs);
  const haystack =
    checkpoint.kind === "urlIncludes"
      ? observed.url
      : checkpoint.kind === "titleIncludes"
        ? observed.title
        : `${observed.text}\n${observed.aria}`;
  return haystack.includes(expect);
}

export function describeCheckpoint(checkpoint: Checkpoint, inputs: Record<string, string>): string {
  return `${checkpoint.kind} ${JSON.stringify(expandParams(checkpoint.expect, inputs))}`;
}
