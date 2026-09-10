import type { Surface } from "../core/surface.ts";
import type { Action, ActionResult, ControlOwner, Locator, Observation } from "../core/types.ts";
import { locatorChain, locatorName } from "../replay/locator.ts";

/**
 * Desktop adapter: the same Surface port, resolved against a fake OS
 * accessibility tree rather than Playwright. Proves the seam is real.
 */

export type A11yNode = {
  role: string;
  name: string;
  value?: string;
  text?: string;
  children?: A11yNode[];
};

export type DesktopScreen = "search" | "notice" | "detail" | "notfound" | "denied" | "expired" | "unavailable";

export class DesktopSurface implements Surface {
  screen: DesktopScreen;
  memberId = "";
  private owner: ControlOwner = "automation";
  private readonly id = "desktop-session";
  failNextLocator = false;
  skipPrimary = false;
  failWhenName?: string;
  stickyNotice = false;
  failTransientTimes = 0;

  constructor(start: DesktopScreen = "search") {
    this.screen = start;
  }

  sessionId(): string {
    return this.id;
  }

  whoHasControl(): ControlOwner {
    return this.owner;
  }

  async pause(): Promise<void> {
    this.owner = "human";
  }

  async resume(): Promise<void> {
    this.owner = "automation";
  }

  async observe(): Promise<Observation> {
    const tree = this.tree();
    const refs = flatten(tree).map((node, i) => ({
      ref: `n${i}`,
      role: node.role,
      name: node.name,
    }));
    return {
      url: this.url(),
      title: this.title(),
      aria: serialize(tree),
      text: flatten(tree)
        .map((node) => [node.name, node.text, node.value].filter(Boolean).join(" "))
        .join(" "),
      refs,
      dialog: this.screen === "notice" ? "System Notice" : undefined,
    };
  }

  async act(action: Action): Promise<ActionResult> {
    if (this.owner !== "automation") {
      return { ok: false, error: "Automation does not have control of the session." };
    }
    return this.perform(action);
  }

  async actAsHuman(action: Action): Promise<ActionResult> {
    if (this.owner !== "human") {
      return { ok: false, error: "Human does not have control of the session." };
    }
    return this.perform(action);
  }

  async screenshot(): Promise<Buffer> {
    return Buffer.from("desktop-screenshot");
  }

  async close(): Promise<void> {}

  private async perform(action: Action): Promise<ActionResult> {
    if (this.failNextLocator) {
      this.failNextLocator = false;
      return { ok: false, error: "No locator matched" };
    }
    if (action.name === "navigate") {
      if (this.failTransientTimes > 0) {
        this.failTransientTimes -= 1;
        this.screen = "unavailable";
        return { ok: false, error: "HTTP 503", retryable: true };
      }
      if (action.url?.includes("expired")) this.screen = "expired";
      else if (action.url?.includes("wrong")) this.screen = "search";
      else if (action.url?.includes("flaky") || action.url?.includes("unavailable")) this.screen = "unavailable";
      else this.screen = action.url?.includes("notice") || this.stickyNotice ? "notice" : "search";
      return { ok: true };
    }
    if (action.name === "wait") return { ok: true };

    const used = this.resolve(action);
    const name = locatorName(used ?? action.target?.primary ?? { by: "role" }).toLowerCase();
    if (this.failWhenName && name === this.failWhenName.toLowerCase()) {
      this.failWhenName = undefined;
      return { ok: false, error: "No locator matched" };
    }

    if (action.name === "dismiss") {
      if (this.screen === "notice" && !this.stickyNotice) this.screen = "search";
      return { ok: true, usedLocator: used ?? { by: "role", role: "button", name: "Dismiss" } };
    }

    if (action.target && !used) return { ok: false, error: "No locator matched" };

    if (action.name === "type" && name === "member id") {
      this.memberId = action.value ?? "";
      const node = used ? this.find(used) : undefined;
      if (node) node.value = this.memberId;
      return { ok: true, usedLocator: used };
    }
    if (action.name === "click" && name === "search") {
      if (this.failTransientTimes > 0) {
        this.failTransientTimes -= 1;
        this.screen = "unavailable";
        return { ok: false, error: "HTTP 503", retryable: true };
      }
      if (this.memberId === "99999") this.screen = "notfound";
      else if (this.memberId === "55555") this.screen = "denied";
      else if (this.memberId === "00000") this.screen = "expired";
      else this.screen = "detail";
      return { ok: true, usedLocator: used };
    }
    if (action.name === "extract") {
      const node = used ? this.find(used) : undefined;
      const extracted = node?.text ?? node?.value ?? (this.screen === "detail" ? "$4,250.00" : undefined);
      if (extracted === undefined) return { ok: false, error: "Extract target not visible", usedLocator: used };
      return { ok: true, extracted, usedLocator: used };
    }
    return { ok: false, error: `Unhandled desktop action ${action.name} ${name}` };
  }

  private resolve(action: Action): Locator | undefined {
    if (!action.target) return undefined;
    const chain = locatorChain(action.target);
    const start = this.skipPrimary ? 1 : 0;
    for (const locator of chain.slice(start)) {
      if (this.find(locator)) return locator;
    }
    return undefined;
  }

  private find(locator: Locator): A11yNode | undefined {
    for (const node of flatten(this.tree())) {
      if (locator.by === "role" && node.role === locator.role && node.name === locator.name) return node;
      if (locator.by === "label" && node.name === locator.name) return node;
      if (locator.by === "text") {
        const needle = locator.text ?? "";
        if (node.name.includes(needle) || (node.text ?? "").includes(needle)) return node;
      }
      if (locator.by === "css" && locator.selector && node.name && locator.selector.includes(node.name)) return node;
    }
    return undefined;
  }

  private url(): string {
    if (this.screen === "detail") return "http://127.0.0.1:3000/member/12345";
    if (this.screen === "notfound") return "http://127.0.0.1:3000/search?mid=99999";
    if (this.screen === "denied") return "http://127.0.0.1:3000/search?mid=55555";
    if (this.screen === "expired") return "http://127.0.0.1:3000/?expired=1";
    if (this.screen === "unavailable") return "http://127.0.0.1:3000/?flaky=1";
    if (this.screen === "notice") return "http://127.0.0.1:3000/?notice=1";
    return "http://127.0.0.1:3000/";
  }

  private title(): string {
    if (this.screen === "notfound") return "Relay Credit Union — Member not found";
    if (this.screen === "denied") return "Relay Credit Union — Access denied";
    if (this.screen === "expired") return "Relay Credit Union — Session expired";
    if (this.screen === "unavailable") return "Relay Credit Union — Unavailable";
    if (this.screen === "detail") return "Relay Credit Union — Member 12345";
    return "Relay Credit Union — Member Servicing";
  }

  private tree(): A11yNode[] {
    if (this.screen === "notice") {
      return [
        {
          role: "dialog",
          name: "System Notice",
          text: "Scheduled core maintenance",
          children: [{ role: "button", name: "Dismiss" }],
        },
      ];
    }
    if (this.screen === "notfound") {
      return [{ role: "alert", name: "Member not found", text: "No member record matches the ID provided (99999)." }];
    }
    if (this.screen === "denied") {
      return [{ role: "alert", name: "Permission denied", text: "You are not authorized to view member 55555." }];
    }
    if (this.screen === "expired") {
      return [{ role: "alert", name: "Session expired", text: "Your teller session has timed out." }];
    }
    if (this.screen === "unavailable") {
      return [{ role: "alert", name: "Core temporarily unavailable", text: "The servicing host returned HTTP 503." }];
    }
    if (this.screen === "detail") {
      return [
        { role: "heading", name: "Member 12345" },
        { role: "cell", name: "Savings Balance", text: "$4,250.00" },
        { role: "cell", name: "Checking Balance", text: "$1,102.33" },
      ];
    }
    return [
      { role: "heading", name: "Member Lookup", text: "Member Lookup" },
      { role: "textbox", name: "Member ID", value: this.memberId },
      { role: "button", name: "Search" },
    ];
  }
}

function flatten(nodes: A11yNode[]): A11yNode[] {
  const out: A11yNode[] = [];
  for (const node of nodes) {
    out.push(node);
    if (node.children) out.push(...flatten(node.children));
  }
  return out;
}

function serialize(nodes: A11yNode[], indent = 0): string {
  return nodes
    .map((node) => {
      const line = `${"  ".repeat(indent)}- ${node.role} "${node.name}"`;
      const kids = node.children?.length ? `\n${serialize(node.children, indent + 1)}` : "";
      return `${line}${kids}`;
    })
    .join("\n");
}
