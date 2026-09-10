import { randomBytes } from "node:crypto";

type Issued = {
  action: string;
  expiresAt: number;
};

/**
 * Single-use form tokens for irreversible POSTs. Not a browser cookie session —
 * the review page mints a token, Confirm must post it back.
 */
export class FormTokenStore {
  private readonly tokens = new Map<string, Issued>();
  private readonly ttlMs: number;

  constructor(ttlMs = 15 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  issue(action: string): string {
    const token = randomBytes(16).toString("hex");
    this.tokens.set(token, { action, expiresAt: Date.now() + this.ttlMs });
    return token;
  }

  consume(token: string | undefined, action: string): boolean {
    if (!token) return false;
    const issued = this.tokens.get(token);
    this.tokens.delete(token);
    if (!issued) return false;
    if (issued.action !== action) return false;
    if (issued.expiresAt < Date.now()) return false;
    return true;
  }

  reset(): void {
    this.tokens.clear();
  }
}
