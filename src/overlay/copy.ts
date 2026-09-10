import type { Capability, Locator, Target } from "../core/types.ts";

/**
 * Phrase replace with word boundaries so `Confirm` does not clobber `Confirmation`.
 * Longer source strings win first (`Member Lookup` before `Lookup`).
 */
export function remapPhrase(value: string, copy: Record<string, string>): string {
  if (!value || Object.keys(copy).length === 0) return value;
  if (copy[value]) return copy[value]!;
  let out = value;
  const keys = Object.keys(copy).sort((a, b) => b.length - a.length);
  for (const from of keys) {
    const to = copy[from]!;
    const re = new RegExp(`\\b${escapeRegExp(from)}\\b`, "g");
    out = out.replace(re, to);
  }
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function remapLocator(locator: Locator, copy: Record<string, string>): Locator {
  return {
    ...locator,
    name: locator.name ? remapPhrase(locator.name, copy) : locator.name,
    text: locator.text ? remapPhrase(locator.text, copy) : locator.text,
    selector: locator.selector ? remapPhrase(locator.selector, copy) : locator.selector,
    cell: locator.cell ? remapPhrase(locator.cell, copy) : locator.cell,
    scope:
      locator.scope?.by === "region"
        ? { ...locator.scope, heading: remapPhrase(locator.scope.heading, copy) }
        : locator.scope,
  };
}

function remapTarget(target: Target | undefined, copy: Record<string, string>): Target | undefined {
  if (!target) return target;
  return {
    primary: remapLocator(target.primary, copy),
    fallbacks: target.fallbacks?.map((locator) => remapLocator(locator, copy)),
  };
}

/** Apply a composed copy map to every human-visible string on the capability. */
export function applyCopy(capability: Capability, copy: Record<string, string>): Capability {
  if (Object.keys(copy).length === 0) return capability;
  const next = structuredClone(capability);
  for (const step of next.steps) {
    step.target = remapTarget(step.target, copy);
    if (step.checkpoint) step.checkpoint = { ...step.checkpoint, expect: remapPhrase(step.checkpoint.expect, copy) };
    if (step.antiCheckpoints) {
      step.antiCheckpoints = step.antiCheckpoints.map((check) => ({
        ...check,
        expect: remapPhrase(check.expect, copy),
      }));
    }
    if (step.note) step.note = remapPhrase(step.note, copy);
  }
  for (const output of next.outputs) {
    output.locator = remapTarget(output.locator, copy) ?? output.locator;
  }
  next.preconditions.entryCheckpoint = {
    ...next.preconditions.entryCheckpoint,
    expect: remapPhrase(next.preconditions.entryCheckpoint.expect, copy),
  };
  next.success.checkpoint = {
    ...next.success.checkpoint,
    expect: remapPhrase(next.success.checkpoint.expect, copy),
  };
  if (next.antiCheckpoints) {
    next.antiCheckpoints = next.antiCheckpoints.map((check) => ({
      ...check,
      expect: remapPhrase(check.expect, copy),
    }));
  }
  next.exceptionalStates = next.exceptionalStates.map((state) => ({
    ...state,
    detect: {
      ...state.detect,
      textIncludes: state.detect.textIncludes
        ? remapPhrase(state.detect.textIncludes, copy)
        : state.detect.textIncludes,
      dialogTitle: state.detect.dialogTitle
        ? remapPhrase(state.detect.dialogTitle, copy)
        : state.detect.dialogTitle,
    },
    recoverAction: state.recoverAction
      ? {
          ...state.recoverAction,
          target: remapTarget(state.recoverAction.target, copy),
        }
      : state.recoverAction,
  }));
  return next;
}
