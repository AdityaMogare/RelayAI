import { ApprovalError } from "../core/errors.ts";
import type { ArtifactStep, Capability } from "../core/types.ts";

export type ReviewFinding = {
  stepId: string;
  control: string;
  recorded: "safe" | "risky";
  issue: string;
};

const IRREVERSIBLE = /\b(confirm|delete|approve|wire|transfer)\b/i;

/**
 * Approval-time diff. Runtime does not re-classify "Submit search" vs "Post payment".
 * A Confirm step marked safe is caught here, not by keyword matching during replay.
 */
export function reviewCapability(capability: Capability): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  for (const step of capability.steps) {
    const control = controlName(step);
    if (!control) continue;
    if (IRREVERSIBLE.test(control) && step.risk === "safe") {
      findings.push({
        stepId: step.id,
        control,
        recorded: "safe",
        issue: `Control ${JSON.stringify(control)} looks irreversible but step.risk is "safe". The reviewer must mark it risky or change the control.`,
      });
    }
  }
  return findings;
}

export function assertTwoPersonApproval(capability: Capability): void {
  const needs = capability.steps.some((s) => s.risk === "risky") || capability.sideEffects.kind === "irreversible";
  if (!needs) return;
  const approval = capability.approval;
  if (!approval?.requestedBy?.trim() || !approval.approvedBy?.trim()) {
    throw new ApprovalError(
      "APPROVAL_REQUIRED",
      `${capability.id} has irreversible/high-value work and needs two-person approval (requestedBy ≠ approvedBy).`,
    );
  }
  if (approval.requestedBy.trim().toLowerCase() === approval.approvedBy.trim().toLowerCase()) {
    throw new ApprovalError(
      "TWO_PERSON_RULE",
      `${capability.id} approval must come from someone other than the requester (${approval.requestedBy}).`,
    );
  }
}

export function approveCapability(
  capability: Capability,
  input: { requestedBy: string; approvedBy: string; at?: string },
): Capability {
  if (input.requestedBy.trim().toLowerCase() === input.approvedBy.trim().toLowerCase()) {
    throw new ApprovalError("TWO_PERSON_RULE", "TWO_PERSON_RULE: approvedBy must differ from requestedBy.");
  }
  const findings = reviewCapability(capability);
  if (findings.length > 0) {
    throw new ApprovalError(
      "REVIEW_FAILED",
      `REVIEW_FAILED: ${findings.map((f) => `${f.stepId}: ${f.issue}`).join(" ")}`,
    );
  }
  return {
    ...capability,
    approval: {
      requestedBy: input.requestedBy.trim(),
      approvedBy: input.approvedBy.trim(),
      approvedAt: input.at ?? new Date().toISOString(),
    },
  };
}

function controlName(step: ArtifactStep): string {
  return step.target?.primary.name ?? step.target?.primary.text ?? "";
}
