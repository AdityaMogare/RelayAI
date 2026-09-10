import { RelayError } from "../core/errors.ts";

export type ResolvedCredential = {
  ref: string;
  username: string;
  /** In-memory only. Never log, persist, or return through evidence. */
  secret: string;
};

export interface Vault {
  resolve(ref: string): ResolvedCredential;
}

export class VaultError extends RelayError {
  constructor(message: string) {
    super("VAULT", message);
  }
}

/**
 * `vault://tenant-9/teller` → env `RELAY_VAULT_tenant_9_teller` as `username:secret`.
 * The resolved secret never belongs in an artifact, log, or screenshot caption.
 */
export function parseCredentialRef(ref: string): { tenantId: string; role: string } {
  const match = /^vault:\/\/([^/]+)\/([^/]+)$/.exec(ref.trim());
  if (!match) {
    throw new VaultError(`Malformed credentialRef ${JSON.stringify(ref)}. Expected vault://tenant/role.`);
  }
  return { tenantId: match[1]!, role: match[2]! };
}

export function envKeyForRef(ref: string): string {
  const { tenantId, role } = parseCredentialRef(ref);
  return `RELAY_VAULT_${tenantId.replace(/[^A-Za-z0-9]/g, "_")}_${role.replace(/[^A-Za-z0-9]/g, "_")}`;
}

export class EnvVault implements Vault {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  resolve(ref: string): ResolvedCredential {
    const key = envKeyForRef(ref);
    const raw = this.env[key]?.trim();
    if (!raw) {
      throw new VaultError(`No secret bound for ${ref} (set ${key}).`);
    }
    const split = raw.indexOf(":");
    const username = split === -1 ? "teller" : raw.slice(0, split);
    const secret = split === -1 ? raw : raw.slice(split + 1);
    return { ref, username, secret };
  }
}

export class MemoryVault implements Vault {
  constructor(private readonly secrets: Record<string, { username: string; secret: string }>) {}

  resolve(ref: string): ResolvedCredential {
    parseCredentialRef(ref);
    const hit = this.secrets[ref];
    if (!hit) throw new VaultError(`No secret bound for ${ref}.`);
    return { ref, ...hit };
  }
}

/** Resolve if present. Missing refs are allowed on the mock console (no login step). */
export function resolveCredentialRef(
  ref: string | undefined,
  vault: Vault = new EnvVault(),
): ResolvedCredential | undefined {
  if (!ref) return undefined;
  try {
    return vault.resolve(ref);
  } catch (err) {
    if (err instanceof VaultError) return undefined;
    throw err;
  }
}
