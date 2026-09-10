import { InterventionTransitionError } from "../core/errors.ts";
import type {
  Checkpoint,
  InterventionRequest,
  InterventionState,
  InterventionTransition,
  StepDisposition,
} from "../core/types.ts";

export const INTERVENTION_STATES: InterventionState[] = [
  "raised",
  "claimed",
  "in_control",
  "returned",
  "resolved",
  "abandoned",
];

const ALLOWED: Record<InterventionState, InterventionState[]> = {
  raised: ["claimed", "abandoned"],
  claimed: ["in_control", "abandoned"],
  in_control: ["returned", "abandoned"],
  returned: ["resolved", "abandoned"],
  resolved: [],
  abandoned: [],
};

export function defaultTtlMs(): number {
  const raw = Number(process.env.RELAY_INTERVENTION_TTL_MS ?? 120_000);
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000;
}

/** Lower number = claimed first. Irreversible money movement outranks account opening. */
export function interventionPriority(capabilityId?: string): number {
  const id = capabilityId ?? "";
  if (id.includes("dispute")) return 10;
  if (id.includes("sub-account") || id.includes("open-sub")) return 20;
  return 40;
}

export function entryCheckpointFromUrl(url?: string): Checkpoint | undefined {
  if (!url) return undefined;
  try {
    return { kind: "urlIncludes", expect: new URL(url).pathname };
  } catch {
    return { kind: "urlIncludes", expect: url };
  }
}

export function createIntervention(
  partial: Omit<InterventionRequest, "id" | "createdAt"> & { id: string; createdAt: string },
  ttlMs: number,
): InterventionRequest {
  const at = partial.createdAt;
  return {
    ...partial,
    state: "raised",
    ttlMs,
    expiresAt: new Date(Date.parse(at) + ttlMs).toISOString(),
    queuePriority: partial.queuePriority ?? interventionPriority(partial.capabilityId),
    entryCheckpoint: partial.entryCheckpoint ?? entryCheckpointFromUrl(partial.url),
    transitions: [{ state: "raised", at, note: partial.reason }],
  };
}

export function transition(
  record: InterventionRequest,
  next: InterventionState,
  extra?: { operatorId?: string; note?: string; stepDisposition?: StepDisposition },
): InterventionRequest {
  const current = record.state ?? "raised";
  if (current === next) return record;
  if (!ALLOWED[current].includes(next)) {
    throw new InterventionTransitionError(`Illegal intervention transition ${current} → ${next}`);
  }
  const at = new Date().toISOString();
  const operatorId = extra?.operatorId ?? record.operatorId;
  const step: InterventionTransition = { state: next, at, operatorId, note: extra?.note };
  const nextRecord: InterventionRequest = {
    ...record,
    state: next,
    operatorId,
    stepDisposition: extra?.stepDisposition ?? record.stepDisposition,
    transitions: [...(record.transitions ?? []), step],
  };
  if (next === "claimed") nextRecord.claimedAt = at;
  if (next === "in_control") nextRecord.inControlAt = at;
  if (next === "returned") nextRecord.returnedAt = at;
  if (next === "resolved") nextRecord.resolvedAt = at;
  if (next === "abandoned") nextRecord.abandonedAt = at;
  return nextRecord;
}

export function sortQueue(records: InterventionRequest[]): InterventionRequest[] {
  return [...records].sort((a, b) => {
    const pa = a.queuePriority ?? interventionPriority(a.capabilityId);
    const pb = b.queuePriority ?? interventionPriority(b.capabilityId);
    if (pa !== pb) return pa - pb;
    return (a.createdAt ?? "").localeCompare(b.createdAt ?? "");
  });
}

/** At most one operator may hold the live console. Claimed and in_control both count as holding. */
export function holderOf(records: InterventionRequest[]): InterventionRequest | undefined {
  return records.find((r) => r.state === "in_control" || r.state === "claimed");
}

export function auditLine(record: InterventionRequest): string {
  const operator = record.operatorId ?? "unclaimed";
  const kind = record.operatorKind ? ` (${record.operatorKind})` : "";
  const claimed = record.claimedAt ?? record.inControlAt;
  const returned = record.returnedAt ?? record.resolvedAt ?? record.abandonedAt;
  if (!claimed) return `Intervention ${record.id} is ${record.state} (nobody claimed).`;
  const back = returned ? ` and returned it at ${returned}` : " and still holds it";
  return `operator ${operator}${kind} took control at ${claimed}${back}`;
}
