import type { Capability, Locator, LocatorHit, LocatorScope, Target } from "../core/types.ts";

function escapeAttr(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/** Ranked chain the schema promises: role+name → label → text → css. */
export function rankedTarget(role: string, name: string, scope?: LocatorScope): Target {
  const chain: Target = {
    primary: { by: "role", role, name },
    fallbacks: [
      { by: "label", name },
      { by: "text", text: name },
      { by: "css", selector: `[aria-label="${escapeAttr(name)}"]` },
    ],
  };
  return scope ? withScope(chain, scope) : chain;
}

export function rankedTargetFrom(target: Target | undefined): Target | undefined {
  if (!target) return undefined;
  if (target.primary.by === "cellInRow") return target;
  const name = target.primary.name ?? target.primary.text;
  if (!name) return target;
  const role = target.primary.role ?? "generic";
  const chain = rankedTarget(role, name, target.primary.scope);
  if (!hasFullChain(target)) return chain;
  return target.primary.scope && !target.fallbacks?.[0]?.scope ? withScope(target, target.primary.scope) : target;
}

function withScope(target: Target, scope: LocatorScope): Target {
  return {
    primary: { ...target.primary, scope },
    fallbacks: target.fallbacks?.map((locator) => ({ ...locator, scope })),
  };
}

function hasFullChain(target: Target): boolean {
  const kinds = new Set<Locator["by"]>([
    target.primary.by,
    ...(target.fallbacks ?? []).map((f) => f.by),
  ]);
  return kinds.has("role") && kinds.has("label") && kinds.has("text") && kinds.has("css");
}

/**
 * After a rank-N fallback, promote the locator that actually matched to
 * primary and rebuild the a11y-first chain. That is v2: same capability,
 * healthy locators, confidence back to 1.
 */
export function promoteHits(capability: Capability, hits: LocatorHit[]): Capability {
  const next = structuredClone(capability);
  next.version += 1;
  for (const hit of hits) {
    if (hit.rank <= 1) continue;
    const step = next.steps.find((s) => s.id === hit.stepId);
    if (!step?.target) continue;
    if (hit.locator.by === "cellInRow") {
      step.target = { primary: hit.locator, fallbacks: step.target.fallbacks };
      continue;
    }
    const name = hit.locator.name ?? hit.locator.text ?? step.target.primary.name;
    const role = hit.locator.role ?? step.target.primary.role ?? "generic";
    if (name) step.target = rankedTarget(role, name, hit.locator.scope ?? step.target.primary.scope);
  }
  return next;
}
