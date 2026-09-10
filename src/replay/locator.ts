import type { Locator, LocatorBy, LocatorHit, Target } from "../core/types.ts";

export function locatorsEqual(a: Locator, b: Locator): boolean {
  return (
    a.by === b.by &&
    (a.role ?? "") === (b.role ?? "") &&
    (a.name ?? "") === (b.name ?? "") &&
    (a.text ?? "") === (b.text ?? "") &&
    (a.selector ?? "") === (b.selector ?? "") &&
    (a.cell ?? "") === (b.cell ?? "") &&
    (a.row?.matches ?? "") === (b.row?.matches ?? "") &&
    JSON.stringify(a.scope ?? null) === JSON.stringify(b.scope ?? null)
  );
}

export function locatorChain(target: Target): Locator[] {
  return [target.primary, ...(target.fallbacks ?? [])];
}

/** 1-based rank in the chain. Undefined if the used locator is not in the chain. */
export function rankInChain(target: Target | undefined, used: Locator | undefined): number | undefined {
  if (!target || !used) return undefined;
  const idx = locatorChain(target).findIndex((locator) => locatorsEqual(locator, used));
  return idx === -1 ? undefined : idx + 1;
}

export function locatorName(locator: Locator): string {
  if (locator.name) return locator.name;
  if (locator.cell) return locator.cell;
  if (locator.text) return locator.text;
  const match = locator.selector?.match(/aria-label="([^"]+)"/);
  return match?.[1] ?? "";
}

export function driftFromHits(hits: LocatorHit[]): { needsRediscovery: boolean; confidence: number } {
  if (hits.length === 0) return { needsRediscovery: false, confidence: 1 };
  const rank1 = hits.filter((hit) => hit.rank === 1).length;
  return {
    needsRediscovery: hits.some((hit) => hit.rank > 1),
    confidence: rank1 / hits.length,
  };
}

export function hitFromMatch(
  stepId: string,
  target: Target | undefined,
  used: Locator | undefined,
): LocatorHit | undefined {
  if (!used) return undefined;
  const rank = rankInChain(target, used) ?? 0;
  return { stepId, rank, by: used.by as LocatorBy, locator: used };
}
