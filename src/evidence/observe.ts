import type { Observation } from "../core/types.ts";

/** What we persist: URL, title, control inventory. Not member-record text or a11y trees. */
export function publicObservation(obs: Observation): Record<string, unknown> {
  return {
    url: obs.url,
    title: obs.title,
    controls: obs.refs.map((ref) => ({ role: ref.role, name: ref.name })),
    dialog: obs.dialog,
  };
}

export function summarizePublic(obs: Observation): string {
  const controls = obs.refs.map((ref) => ref.name).filter(Boolean).join(", ");
  return `${obs.title} | ${obs.url}${controls ? ` | ${controls}` : ""}`;
}
