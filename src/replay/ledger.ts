import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Capability, RunStatus } from "../core/types.ts";
import { sha256Utf8 } from "../artifact/hash.ts";

export type LedgerEntry = {
  at: string;
  capabilityId: string;
  idempotencyKey: string;
  status: RunStatus;
  runId: string;
  tenantId?: string;
  memberId?: string;
  credentialRef?: string;
  routes?: string[];
  fallbackHits?: number;
  targetedHits?: number;
  checkpointMiss?: boolean;
  needsRediscovery?: boolean;
  code?: string;
};

export interface RunLedger {
  find(capabilityId: string, idempotencyKey: string): Promise<LedgerEntry | undefined>;
  append(entry: LedgerEntry): Promise<void>;
}

export function idempotencyKeyFor(capability: Capability, inputs: Record<string, string>): string {
  const names = (capability.idempotencyKeyFrom ?? capability.parameters.map((p) => p.name)).slice().sort();
  const picked = Object.fromEntries(names.map((name) => [name, inputs[name] ?? ""]));
  return sha256Utf8(`${capability.id}:${JSON.stringify(picked)}`);
}

export class MemoryRunLedger implements RunLedger {
  private readonly entries: LedgerEntry[] = [];

  async find(capabilityId: string, idempotencyKey: string): Promise<LedgerEntry | undefined> {
    return [...this.entries].reverse().find(
      (e) => e.capabilityId === capabilityId && e.idempotencyKey === idempotencyKey && e.status === "success",
    );
  }

  async append(entry: LedgerEntry): Promise<void> {
    this.entries.push(entry);
  }
}

/** Append-only operational store. Artifacts live in git; runs live here. */
export class FileRunLedger implements RunLedger {
  constructor(private readonly path = resolve(process.cwd(), "runs", "ledger.jsonl")) {
    mkdirSync(dirname(this.path), { recursive: true });
  }

  async find(capabilityId: string, idempotencyKey: string): Promise<LedgerEntry | undefined> {
    const entries = this.readAll();
    return [...entries].reverse().find(
      (e) => e.capabilityId === capabilityId && e.idempotencyKey === idempotencyKey && e.status === "success",
    );
  }

  async append(entry: LedgerEntry): Promise<void> {
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, "utf8");
  }

  private readAll(): LedgerEntry[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LedgerEntry);
  }
}

export type AuditQuery = {
  memberId?: string;
  tenantId?: string;
  from?: string;
  to?: string;
};

/** Regulator: what did this automation touch for member 12345 last Tuesday? */
export function queryAudit(entries: LedgerEntry[], query: AuditQuery): LedgerEntry[] {
  const from = query.from ? Date.parse(query.from) : undefined;
  const to = query.to ? Date.parse(query.to) : undefined;
  return entries.filter((entry) => {
    if (query.memberId && entry.memberId !== query.memberId) return false;
    if (query.tenantId && entry.tenantId !== query.tenantId) return false;
    const at = Date.parse(entry.at);
    if (from !== undefined && !Number.isNaN(from) && at < from) return false;
    if (to !== undefined && !Number.isNaN(to) && at > to) return false;
    return true;
  });
}

export function readLedgerFile(path = resolve(process.cwd(), "runs", "ledger.jsonl")): LedgerEntry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LedgerEntry);
}
