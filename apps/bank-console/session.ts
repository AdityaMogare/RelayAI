import { randomUUID } from "node:crypto";

export const SESSION_COOKIE = "relay_sid";
export const UI_COOKIE = "relay_ui";
export const TENANT_COOKIE = "relay_tenant";
export const SESSION_TTL_MS = 90_000;
export const DEMO_TELLER = { username: "teller01", secret: "relay-teller-9" } as const;

export type TellerUser = { username: string; secret: string };

export type TellerSession = {
  id: string;
  username: string;
  createdAt: number;
  expiresAt: number;
  hits: number;
  expireAfter?: number;
};

export class SessionStore {
  private readonly sessions = new Map<string, TellerSession>();

  constructor(private readonly ttlMs = SESSION_TTL_MS) {}

  create(username: string, expireAfter?: number): TellerSession {
    const now = Date.now();
    const session: TellerSession = {
      id: randomUUID(),
      username,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      hits: 0,
      expireAfter,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string | undefined): TellerSession | undefined {
    if (!id) return undefined;
    const session = this.sessions.get(id);
    if (!session) return undefined;
    if (Date.now() > session.expiresAt) {
      this.sessions.delete(id);
      return undefined;
    }
    return session;
  }

  /** Count this HTML request. Returns undefined when the session should die. */
  hit(session: TellerSession): TellerSession | undefined {
    session.hits += 1;
    if (session.expireAfter !== undefined && session.hits > session.expireAfter) {
      this.sessions.delete(session.id);
      return undefined;
    }
    return session;
  }

  destroy(id: string): void {
    this.sessions.delete(id);
  }

  setExpireAfter(session: TellerSession, n: number): void {
    session.expireAfter = n;
  }
}

export function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

export function cookieHeader(name: string, value: string, maxAgeSec: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Max-Age=${maxAgeSec}; SameSite=Lax`;
}

export function clearCookieHeader(name: string): string {
  return `${name}=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax`;
}

export function authenticate(users: TellerUser[], username: string, secret: string): boolean {
  return users.some((user) => user.username === username && user.secret === secret);
}
