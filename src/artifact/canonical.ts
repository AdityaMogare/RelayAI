import type { Locator, LocatorScope, Target } from "../core/types.ts";

/**
 * Recorded URLs keep the path shape and substitute parameter values:
 * `/member/12345` → `/member/:memberId`. Replay expands the tokens from inputs.
 */

export function canonicalizePath(path: string, params: Record<string, string>): string {
  let out = path;
  const entries = Object.entries(params)
    .filter(([, value]) => Boolean(value))
    .sort((a, b) => b[1]!.length - a[1]!.length);
  for (const [name, value] of entries) {
    out = out.split(value).join(`:${name}`);
  }
  return out;
}

export function canonicalizeUrl(url: string, params: Record<string, string>): string {
  try {
    const parsed = new URL(url);
    parsed.pathname = canonicalizePath(parsed.pathname, params);
    return parsed.toString();
  } catch {
    return canonicalizePath(url, params);
  }
}

/**
 * Expand parameter tokens in locators, URLs, and checkpoints.
 * Supports `:disputeId` and `{{parameters.disputeId}}`.
 * Leaves `:3000`-style port numbers alone (token must start with a letter).
 */
export function expandParams(template: string, inputs: Record<string, string>): string {
  const mustache = template.replace(/\{\{parameters\.([A-Za-z_][A-Za-z0-9_]*)\}\}/g, (whole, name: string) => {
    const value = inputs[name];
    return value !== undefined ? value : whole;
  });
  return mustache.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (whole, name: string) => {
    const value = inputs[name];
    return value !== undefined ? value : whole;
  });
}

function expandScope(scope: LocatorScope | undefined, inputs: Record<string, string>): LocatorScope | undefined {
  if (!scope) return scope;
  if (scope.by === "row") {
    return { by: "row", hasText: scope.hasText.map((text) => expandParams(text, inputs)) };
  }
  return { by: "region", heading: expandParams(scope.heading, inputs) };
}

export function expandLocator(locator: Locator, inputs: Record<string, string>): Locator {
  return {
    ...locator,
    name: locator.name ? expandParams(locator.name, inputs) : locator.name,
    text: locator.text ? expandParams(locator.text, inputs) : locator.text,
    selector: locator.selector ? expandParams(locator.selector, inputs) : locator.selector,
    cell: locator.cell ? expandParams(locator.cell, inputs) : locator.cell,
    row: locator.row ? { matches: expandParams(locator.row.matches, inputs) } : locator.row,
    scope: expandScope(locator.scope, inputs),
  };
}

export function expandTarget(target: Target | undefined, inputs: Record<string, string>): Target | undefined {
  if (!target) return target;
  return {
    primary: expandLocator(target.primary, inputs),
    fallbacks: target.fallbacks?.map((locator) => expandLocator(locator, inputs)),
  };
}
