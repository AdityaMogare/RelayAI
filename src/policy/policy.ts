import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Action, ActionName, RiskClass } from "../core/types.ts";

export type PolicyConfig = {
  allowedHosts: string[];
  allowedActions: ActionName[];
  riskyActions: ActionName[];
  riskyNames: string[];
};

const DEFAULT_POLICY: PolicyConfig = {
  allowedHosts: ["127.0.0.1", "localhost"],
  allowedActions: ["navigate", "click", "type", "select", "extract", "dismiss", "wait"],
  riskyActions: ["click"],
  riskyNames: ["confirm", "delete", "submit", "open sub-account", "approve"],
};

export function loadPolicy(path = resolve(process.cwd(), "policy/allowlist.yaml")): PolicyConfig {
  try {
    const parsed = parseYaml(readFileSync(path, "utf8")) as Partial<PolicyConfig>;
    return {
      allowedHosts: parsed.allowedHosts ?? DEFAULT_POLICY.allowedHosts,
      allowedActions: parsed.allowedActions ?? DEFAULT_POLICY.allowedActions,
      riskyActions: parsed.riskyActions ?? DEFAULT_POLICY.riskyActions,
      riskyNames: (parsed.riskyNames ?? DEFAULT_POLICY.riskyNames).map((n) => n.toLowerCase()),
    };
  } catch {
    return DEFAULT_POLICY;
  }
}

export class PolicyViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyViolation";
  }
}

export class PolicyGuard {
  constructor(private readonly config: PolicyConfig = loadPolicy()) {}

  assertAction(action: Action, currentOrigin?: string): void {
    if (!this.config.allowedActions.includes(action.name)) {
      throw new PolicyViolation(`Action "${action.name}" is not allowlisted.`);
    }
    if (action.name === "navigate" && action.url) {
      this.assertUrl(action.url);
    }
    if (currentOrigin && !isUncheckedOrigin(currentOrigin)) {
      this.assertUrl(currentOrigin);
    }
  }

  assertUrl(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new PolicyViolation(`Blocked unparseable URL.`);
    }
    const host = parsed.hostname;
    const allowed = this.config.allowedHosts.some((h) => host === h || host.endsWith(`.${h}`));
    if (!allowed) {
      throw new PolicyViolation(`Host "${host}" is not allowlisted.`);
    }
  }

  riskFor(action: Action, controlName?: string): RiskClass {
    const name = (controlName ?? action.target?.primary.name ?? action.value ?? "").toLowerCase();
    if (this.config.riskyNames.some((n) => riskyNameMatches(name, n))) return "risky";
    if (action.name === "navigate") return "safe";
    return "safe";
  }

  isRiskyName(name: string): boolean {
    const lower = name.toLowerCase();
    return this.config.riskyNames.some((n) => riskyNameMatches(lower, n));
  }
}

function riskyNameMatches(name: string, risky: string): boolean {
  if (name === risky) return true;
  if (risky.includes(" ") && name.includes(risky)) return true;
  return name.split(/[^a-z0-9]+/).includes(risky);
}

function isUncheckedOrigin(url: string): boolean {
  return url === "about:blank" || url.startsWith("about:") || url.startsWith("data:") || url.startsWith("blob:");
}
