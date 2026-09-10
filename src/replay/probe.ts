import type { Surface } from "../core/surface.ts";
import { locatorLabel } from "../core/surface.ts";
import type { Capability, Checkpoint, Observation } from "../core/types.ts";
import { expandParams } from "../artifact/canonical.ts";
import { locatorName } from "./locator.ts";
import { rewriteBase } from "./url.ts";

export type ProbeLocator = {
  stepId: string;
  name: string;
  present: boolean;
};

export type ProbeResult = {
  applicable: boolean;
  reason: string;
  entryCheckpoint: { expect: string; held: boolean };
  locators: ProbeLocator[];
  missing: string[];
};

function haystack(kind: Checkpoint["kind"], observed: Observation): string {
  if (kind === "urlIncludes") return observed.url;
  if (kind === "titleIncludes") return observed.title;
  return `${observed.text}\n${observed.aria}`;
}

function observationHas(observed: Observation, name: string): boolean {
  const needle = name.toLowerCase();
  if (observed.refs.some((ref) => ref.name.toLowerCase() === needle)) return true;
  const blob = `${observed.aria}\n${observed.text}`.toLowerCase();
  return blob.includes(needle);
}

/**
 * Cheap read-only check before a tenant run. Navigates to the entry URL and
 * confirms the landing screen + first-screen locators. Never clicks Confirm.
 */
export async function probeApplicability(
  surface: Surface,
  capability: Capability,
  options: { baseUrl?: string; inputs?: Record<string, string> } = {},
): Promise<ProbeResult> {
  const inputs = options.inputs ?? {};
  const nav = capability.steps.find((step) => step.action === "navigate");
  if (nav?.url) {
    await surface.act({
      name: "navigate",
      url: rewriteBase(expandParams(nav.url, inputs), options.baseUrl),
    });
  }
  const observed = await surface.observe();
  const entry = capability.preconditions.entryCheckpoint;
  const expect = expandParams(entry.expect, inputs);
  const held = haystack(entry.kind, observed).includes(expect);

  const locators: ProbeLocator[] = [];
  for (const step of capability.steps) {
    if (step.action === "navigate" || !step.target) continue;
    if (step.risk === "risky") break;
    const name = locatorName(step.target.primary) || locatorLabel(step.target.primary);
    locators.push({ stepId: step.id, name, present: observationHas(observed, name) });
    if (step.action === "click") break;
  }

  const missing = locators.filter((item) => !item.present).map((item) => item.name);
  const applicable = held && missing.length === 0;
  let reason: string;
  if (applicable) {
    reason = `Entry screen matches ${capability.id}. Safe to replay.`;
  } else if (!held) {
    reason = `Entry checkpoint failed (${entry.kind} ${JSON.stringify(expect)}). Artifact is not bound to this app — not clicking anything.`;
  } else {
    reason = `Entry screen is missing ${missing.join(", ")}. Bind an overlay or re-discover; do not run.`;
  }
  return { applicable, reason, entryCheckpoint: { expect, held }, locators, missing };
}
