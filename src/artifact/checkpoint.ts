import type { Checkpoint, Observation } from "../core/types.ts";
import { canonicalizePath } from "./canonical.ts";

export const EMPTY_OBSERVATION: Observation = {
  url: "",
  title: "",
  aria: "",
  text: "",
  refs: [],
};

/**
 * Per-step checkpoint from what actually changed after the action.
 * Prefer url, then title, then a newly appeared text snippet. Values from the
 * goal (member ids, etc.) are stripped so the artifact stays parameterized.
 */
export function checkpointFromDelta(
  before: Observation,
  after: Observation,
  avoid: string[] = [],
  params: Record<string, string> = {},
): Checkpoint | undefined {
  if (after.url !== before.url) {
    const expect = distinctiveUrlFragment(before.url, after.url, avoid, params);
    if (expect) return { kind: "urlIncludes", expect };
  }
  if (after.title !== before.title) {
    const expect = distinctiveSnippet(after.title, avoid);
    if (expect) return { kind: "titleIncludes", expect };
  }
  if (after.text !== before.text) {
    const expect = distinctiveTextDelta(before.text, after.text, avoid);
    if (expect) return { kind: "textIncludes", expect };
  }
  return undefined;
}

function distinctiveUrlFragment(
  beforeUrl: string,
  afterUrl: string,
  avoid: string[],
  params: Record<string, string>,
): string | undefined {
  try {
    const before = new URL(beforeUrl, "http://local.invalid");
    const after = new URL(afterUrl, "http://local.invalid");
    const canonical = canonicalizePath(after.pathname, params);
    if (canonical.includes(":")) return canonical;
    let path = after.pathname;
    for (const value of avoid) {
      if (value) path = path.split(value).join("");
    }
    path = path.replace(/\/{2,}/g, "/");
    const afterSegs = path.split("/").filter(Boolean);
    if (afterSegs.length === 0) return undefined;
    const beforePath = stripAvoid(before.pathname, avoid);
    const beforeSegs = beforePath.split("/").filter(Boolean);
    const added = afterSegs.filter((seg) => !beforeSegs.includes(seg));
    const pick = added.at(-1) ?? afterSegs.at(-1);
    if (!pick || avoid.includes(pick)) return undefined;
    return `/${pick}`;
  } catch {
    return undefined;
  }
}

function stripAvoid(path: string, avoid: string[]): string {
  let out = path;
  for (const value of avoid) {
    if (value) out = out.split(value).join("");
  }
  return out.replace(/\/{2,}/g, "/");
}

function distinctiveSnippet(text: string, avoid: string[]): string | undefined {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return undefined;
  if (avoid.some((v) => v && cleaned.includes(v))) {
    const without = avoid.reduce((acc, v) => (v ? acc.split(v).join(" ") : acc), cleaned).replace(/\s+/g, " ").trim();
    if (without.length >= 4) return clip(without);
    return undefined;
  }
  return clip(cleaned);
}

function distinctiveTextDelta(before: string, after: string, avoid: string[]): string | undefined {
  const beforeNorm = normalize(before);
  const phrases = after
    .split(/\n+/)
    .flatMap((line) => line.split(/\s{2,}/))
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length >= 4 && s.length <= 80)
    .filter((s) => !avoid.some((v) => v && s.includes(v)))
    .filter((s) => !beforeNorm.includes(normalize(s)));
  phrases.sort((a, b) => a.length - b.length);
  if (phrases[0]) return clip(phrases[0]);

  const afterNorm = normalize(after);
  if (afterNorm.startsWith(beforeNorm) && afterNorm.length > beforeNorm.length) {
    const added = afterNorm.slice(beforeNorm.length).trim();
    return distinctiveSnippet(added, avoid);
  }
  return distinctiveSnippet(after, avoid);
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clip(value: string): string {
  return value.length <= 80 ? value : value.slice(0, 80).trim();
}
