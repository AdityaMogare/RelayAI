import type { ArtifactStep, Capability } from "../core/types.ts";

export type StepFingerprint = {
  action: string;
  risk: string;
  inputFrom?: string;
  outputName?: string;
  role?: string;
  name?: string;
  scope?: string[];
};

/** Compare compiled step sequences, ignoring ids, notes, provenance, and hashes. */
export function stepFingerprint(step: ArtifactStep): StepFingerprint {
  return {
    action: step.action,
    risk: step.risk,
    inputFrom: step.inputFrom,
    outputName: step.outputName,
    role: step.target?.primary.role,
    name: step.target?.primary.name,
    scope:
      step.target?.primary.scope?.by === "row"
        ? step.target.primary.scope.hasText
        : step.target?.primary.scope?.by === "region"
          ? [step.target.primary.scope.heading]
          : undefined,
  };
}

export function equivalentSteps(a: Capability, b: Capability): boolean {
  if (a.parameters.map((p) => p.name).join() !== b.parameters.map((p) => p.name).join()) return false;
  if (a.steps.length !== b.steps.length) return false;
  return a.steps.every((step, i) => JSON.stringify(stepFingerprint(step)) === JSON.stringify(stepFingerprint(b.steps[i]!)));
}

export function diffSteps(a: Capability, b: Capability): { from: StepFingerprint; to: StepFingerprint; id: string }[] {
  const changes: { from: StepFingerprint; to: StepFingerprint; id: string }[] = [];
  const len = Math.max(a.steps.length, b.steps.length);
  for (let i = 0; i < len; i += 1) {
    const left = a.steps[i];
    const right = b.steps[i];
    if (!left || !right) {
      changes.push({
        id: left?.id ?? right?.id ?? `idx-${i}`,
        from: left ? stepFingerprint(left) : { action: "(missing)", risk: "" },
        to: right ? stepFingerprint(right) : { action: "(missing)", risk: "" },
      });
      continue;
    }
    if (JSON.stringify(stepFingerprint(left)) !== JSON.stringify(stepFingerprint(right))) {
      changes.push({ id: right.id, from: stepFingerprint(left), to: stepFingerprint(right) });
    }
  }
  return changes;
}
