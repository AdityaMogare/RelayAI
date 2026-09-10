import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { RateLimitError } from "../core/errors.ts";

export const DEFAULT_TTL_DAYS = 14;

export type RuntimeConfig = {
  disabled: {
    capabilities: string[];
    tenants: string[];
  };
  blastRadius: {
    maxInvocationsPerCapabilityPerHour: number;
    maxInvocationsPerTenantPerHour: number;
  };
  retention: {
    ttlDays: number;
  };
};

export const DEFAULT_RUNTIME: RuntimeConfig = {
  disabled: { capabilities: [], tenants: [] },
  blastRadius: {
    maxInvocationsPerCapabilityPerHour: 30,
    maxInvocationsPerTenantPerHour: 120,
  },
  retention: { ttlDays: DEFAULT_TTL_DAYS },
};

export function runtimePath(cwd = process.cwd()): string {
  return resolve(cwd, "policy/runtime.yaml");
}

export function loadRuntime(path = runtimePath()): RuntimeConfig {
  if (!existsSync(path)) return structuredClone(DEFAULT_RUNTIME);
  try {
    const parsed = parseYaml(readFileSync(path, "utf8")) as Partial<RuntimeConfig>;
    return {
      disabled: {
        capabilities: parsed.disabled?.capabilities ?? [],
        tenants: parsed.disabled?.tenants ?? [],
      },
      blastRadius: {
        maxInvocationsPerCapabilityPerHour:
          parsed.blastRadius?.maxInvocationsPerCapabilityPerHour ??
          DEFAULT_RUNTIME.blastRadius.maxInvocationsPerCapabilityPerHour,
        maxInvocationsPerTenantPerHour:
          parsed.blastRadius?.maxInvocationsPerTenantPerHour ??
          DEFAULT_RUNTIME.blastRadius.maxInvocationsPerTenantPerHour,
      },
      retention: {
        ttlDays: parsed.retention?.ttlDays ?? DEFAULT_TTL_DAYS,
      },
    };
  } catch {
    return structuredClone(DEFAULT_RUNTIME);
  }
}

export function saveRuntime(config: RuntimeConfig, path = runtimePath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const body = `# Ops levers. Edit this file to disable a tenant or capability — no deploy.
# Evidence screenshots and run dumps expire after retention.ttlDays days.

disabled:
  capabilities: ${yamlList(config.disabled.capabilities)}
  tenants: ${yamlList(config.disabled.tenants)}

blastRadius:
  maxInvocationsPerCapabilityPerHour: ${config.blastRadius.maxInvocationsPerCapabilityPerHour}
  maxInvocationsPerTenantPerHour: ${config.blastRadius.maxInvocationsPerTenantPerHour}

retention:
  ttlDays: ${config.retention.ttlDays}
`;
  writeFileSync(path, body, "utf8");
}

function yamlList(items: string[]): string {
  if (items.length === 0) return "[]";
  return `\n${items.map((i) => `    - ${stringifyYaml(i).trim()}`).join("\n")}`;
}

export function isKilled(config: RuntimeConfig, tenantId: string, capabilityId: string): string | undefined {
  if (config.disabled.tenants.includes(tenantId)) {
    return `Kill switch: tenant ${tenantId} is disabled.`;
  }
  if (config.disabled.capabilities.includes(capabilityId)) {
    return `Kill switch: capability ${capabilityId} is disabled.`;
  }
  return undefined;
}

export type InvocationStamp = {
  at: number;
  tenantId: string;
  capabilityId: string;
};

export interface InvocationStore {
  record(stamp: InvocationStamp): void;
  count(filter: { tenantId?: string; capabilityId?: string; since: number }): number;
}

export class MemoryInvocationStore implements InvocationStore {
  constructor(private readonly stamps: InvocationStamp[] = []) {}

  record(stamp: InvocationStamp): void {
    this.stamps.push(stamp);
  }

  count(filter: { tenantId?: string; capabilityId?: string; since: number }): number {
    return this.stamps.filter((s) => {
      if (s.at < filter.since) return false;
      if (filter.tenantId && s.tenantId !== filter.tenantId) return false;
      if (filter.capabilityId && s.capabilityId !== filter.capabilityId) return false;
      return true;
    }).length;
  }
}

export class FileInvocationStore implements InvocationStore {
  constructor(private readonly path = resolve(process.cwd(), "data/rate-limit.json")) {}

  record(stamp: InvocationStamp): void {
    const all = this.read().filter((s) => s.at > Date.now() - 48 * 3600_000);
    all.push(stamp);
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(all)}\n`, "utf8");
  }

  count(filter: { tenantId?: string; capabilityId?: string; since: number }): number {
    return this.read().filter((s) => {
      if (s.at < filter.since) return false;
      if (filter.tenantId && s.tenantId !== filter.tenantId) return false;
      if (filter.capabilityId && s.capabilityId !== filter.capabilityId) return false;
      return true;
    }).length;
  }

  private read(): InvocationStamp[] {
    if (!existsSync(this.path)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as InvocationStamp[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
}

export class RateLimiter {
  constructor(
    private readonly store: InvocationStore,
    private readonly config: RuntimeConfig["blastRadius"] = loadRuntime().blastRadius,
    private readonly now: () => number = () => Date.now(),
  ) {}

  assert(tenantId: string, capabilityId: string): void {
    const since = this.now() - 3600_000;
    const perCap = this.store.count({ capabilityId, tenantId, since });
    if (perCap >= this.config.maxInvocationsPerCapabilityPerHour) {
      throw new RateLimitError(
        `${capabilityId} for ${tenantId} exceeded ${this.config.maxInvocationsPerCapabilityPerHour}/hour.`,
      );
    }
    const perTenant = this.store.count({ tenantId, since });
    if (perTenant >= this.config.maxInvocationsPerTenantPerHour) {
      throw new RateLimitError(
        `tenant ${tenantId} exceeded ${this.config.maxInvocationsPerTenantPerHour}/hour.`,
      );
    }
    this.store.record({ at: this.now(), tenantId, capabilityId });
  }
}
