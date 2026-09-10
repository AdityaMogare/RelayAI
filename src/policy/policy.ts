import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { PolicyConfigError, RelayError } from "../core/errors.ts";
import type { Action, ActionName, RiskClass } from "../core/types.ts";
import { matchRoute, type RouteRule } from "./routes.ts";

export type PolicyConfig = {
  allowedHosts: string[];
  allowedActions: ActionName[];
  riskyActions: ActionName[];
  riskyNames: string[];
  allowedRoutes: RouteRule[];
  deniedRoutes: RouteRule[];
};

const DEFAULT_ROUTES: RouteRule[] = [
  { method: "GET", path: "/" },
  { method: "GET", path: "/index.html" },
  { method: "GET", path: "/ticker" },
  { method: "GET", path: "/login" },
  { method: "POST", path: "/login" },
  { method: "GET", path: "/logout" },
  { method: "GET", path: "/frames" },
  { method: "GET", path: "/frames/**" },
  { method: "GET", path: "/legacy" },
  { method: "GET", path: "/legacy/**" },
  { method: "GET", path: "/search" },
  { method: "GET", path: "/member/*" },
  { method: "GET", path: "/member/*/sub-account" },
  { method: "POST", path: "/member/*/sub-account/confirm" },
  { method: "GET", path: "/member/*/sub-account/opened" },
  { method: "GET", path: "/member/*/disputes" },
  { method: "GET", path: "/member/*/disputes/open" },
  { method: "GET", path: "/member/*/disputes/*" },
  { method: "GET", path: "/member/*/disputes/*/file" },
  { method: "POST", path: "/member/*/disputes/*/submit" },
  { method: "GET", path: "/member/*/disputes/*/receipt" },
];

const DEFAULT_DENIED: RouteRule[] = [
  { method: "*", path: "/admin" },
  { method: "*", path: "/admin/**" },
];

const DEFAULT_POLICY: PolicyConfig = {
  allowedHosts: ["127.0.0.1", "localhost"],
  allowedActions: ["navigate", "click", "type", "select", "extract", "dismiss", "wait"],
  riskyActions: ["click"],
  riskyNames: ["confirm", "delete", "approve"],
  allowedRoutes: DEFAULT_ROUTES,
  deniedRoutes: DEFAULT_DENIED,
};

export function loadPolicy(path = resolve(process.cwd(), "policy/allowlist.yaml")): PolicyConfig {
  if (!existsSync(path)) {
    throw new PolicyConfigError(`Allowlist not found at ${path}.`);
  }
  try {
    const parsed = parseYaml(readFileSync(path, "utf8")) as Partial<PolicyConfig>;
    return normalizePolicy(parsed);
  } catch (err) {
    if (err instanceof PolicyConfigError) throw err;
    throw new PolicyConfigError(`Cannot parse allowlist at ${path}.`, err);
  }
}

function normalizePolicy(parsed: Partial<PolicyConfig>): PolicyConfig {
  return {
    allowedHosts: parsed.allowedHosts ?? DEFAULT_POLICY.allowedHosts,
    allowedActions: parsed.allowedActions ?? DEFAULT_POLICY.allowedActions,
    riskyActions: parsed.riskyActions ?? DEFAULT_POLICY.riskyActions,
    riskyNames: (parsed.riskyNames ?? DEFAULT_POLICY.riskyNames).map((n) => n.toLowerCase()),
    allowedRoutes: parsed.allowedRoutes ?? DEFAULT_POLICY.allowedRoutes,
    deniedRoutes: parsed.deniedRoutes ?? DEFAULT_POLICY.deniedRoutes,
  };
}

export class PolicyViolation extends RelayError {
  constructor(message: string) {
    super("POLICY_VIOLATION", message);
  }
}

export class PolicyGuard {
  private readonly config: PolicyConfig;

  constructor(config: Partial<PolicyConfig> = loadPolicy()) {
    this.config = normalizePolicy(config);
  }

  assertAction(action: Action, currentOrigin?: string): void {
    if (!this.config.allowedActions.includes(action.name)) {
      throw new PolicyViolation(`Action "${action.name}" is not allowlisted.`);
    }
    if (action.name === "navigate" && action.url) {
      this.assertRequest("GET", action.url);
    }
    if (currentOrigin && !isUncheckedOrigin(currentOrigin)) {
      this.assertRequest("GET", currentOrigin);
    }
  }

  assertUrl(url: string): void {
    this.assertRequest("GET", url);
  }

  assertRequest(method: string, url: string): void {
    if (isUncheckedOrigin(url)) return;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new PolicyViolation(`Blocked unparseable URL.`);
    }
    const host = parsed.hostname;
    const allowedHost = this.config.allowedHosts.some((h) => host === h || host.endsWith(`.${h}`));
    if (!allowedHost) {
      throw new PolicyViolation(`Host "${host}" is not allowlisted.`);
    }
    const path = parsed.pathname;
    if (this.config.deniedRoutes.some((rule) => matchRoute(rule, method, path))) {
      throw new PolicyViolation(`Denied ${method} ${path}.`);
    }
    const allowed = this.config.allowedRoutes.some((rule) => matchRoute(rule, method, path));
    if (!allowed) {
      throw new PolicyViolation(`Route ${method} ${path} is not allowlisted.`);
    }
  }

  /** Flat no: could this agent ever fetch this path, on any method? */
  couldReach(pathname: string): boolean {
    if (this.config.deniedRoutes.some((rule) => matchRoute(rule, "GET", pathname) || matchRoute(rule, "POST", pathname))) {
      return false;
    }
    return this.config.allowedRoutes.some((rule) => matchRoute({ ...rule, method: "*" }, "GET", pathname));
  }

  /**
   * Discovery proposal only. Exact control-name match — not token-splitting
   * "submit" out of "Submit search". Replay never calls this.
   */
  proposeRisk(action: Action, controlName?: string): RiskClass {
    const name = (controlName ?? action.target?.primary.name ?? action.value ?? "").toLowerCase().trim();
    if (this.config.riskyNames.some((n) => name === n)) return "risky";
    return "safe";
  }

  /** @deprecated Replay must use step.risk. Kept as an alias of proposeRisk for discovery. */
  riskFor(action: Action, controlName?: string): RiskClass {
    return this.proposeRisk(action, controlName);
  }

  isRiskyName(name: string): boolean {
    const lower = name.toLowerCase().trim();
    return this.config.riskyNames.some((n) => lower === n);
  }
}

export function isUncheckedOrigin(url: string): boolean {
  return url === "about:blank" || url.startsWith("about:") || url.startsWith("data:") || url.startsWith("blob:");
}
