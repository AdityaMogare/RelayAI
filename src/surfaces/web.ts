import { existsSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { Surface } from "../core/surface.ts";
import type {
  Action,
  ActionResult,
  ControlOwner,
  InteractiveRef,
  Locator,
  Observation,
  Target,
} from "../core/types.ts";
import { PolicyGuard, PolicyViolation, isUncheckedOrigin } from "../policy/policy.ts";
import { locateInFrames, parseAriaRefs } from "./locators.ts";

export type WebSurfaceOptions = {
  headed?: boolean;
  startUrl?: string;
  policy?: PolicyGuard;
};

export type PolicyBlock = {
  method: string;
  url: string;
  path: string;
  error: string;
};

export class WebSurface implements Surface {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private owner: ControlOwner = "automation";
  private lastRefs: InteractiveRef[] = [];
  private readonly id = randomUUID();
  private readonly policy: PolicyGuard;
  private readonly blocked: PolicyBlock[] = [];

  constructor(private readonly options: WebSurfaceOptions = {}) {
    this.policy = options.policy ?? new PolicyGuard();
  }

  sessionId(): string {
    return this.id;
  }

  drainPolicyBlocks(): PolicyBlock[] {
    return this.blocked.splice(0);
  }

  async launch(): Promise<void> {
    const executablePath = dockerChromeExecutable();
    this.browser = await chromium.launch({
      headless: this.options.headed ? false : true,
      ...(executablePath ? { executablePath } : {}),
      args: chromiumLaunchArgs(),
    });
    this.context = await this.browser.newContext({ viewport: { width: 1100, height: 800 } });
    this.context.setDefaultTimeout(8_000);
    this.page = await this.context.newPage();
    await this.page.route("**/*", async (route) => {
      const url = route.request().url();
      const method = route.request().method();
      if (isUncheckedOrigin(url)) {
        await route.continue();
        return;
      }
      try {
        this.policy.assertRequest(method, url);
        await route.continue();
      } catch (err) {
        if (err instanceof PolicyViolation) {
          let path = url;
          try {
            path = new URL(url).pathname;
          } catch {
            /* keep raw */
          }
          this.blocked.push({ method, url, path, error: err.message });
          await route.abort("blockedbyclient");
          return;
        }
        throw err;
      }
    });
    if (this.options.startUrl) {
      await this.page.goto(this.options.startUrl, { waitUntil: "domcontentloaded" });
      await this.settle();
    }
  }

  whoHasControl(): ControlOwner {
    return this.owner;
  }

  async pause(): Promise<void> {
    this.owner = "human";
    const page = this.page;
    if (!page) return;
    await page
      .evaluate((id) => {
        let el = document.getElementById("relay-live-session");
        if (!el) {
          el = document.createElement("div");
          el.id = "relay-live-session";
          el.setAttribute("role", "status");
          el.style.cssText = "background:#7a1f1f;color:#fff;padding:6px 12px;font:12px Tahoma,sans-serif;";
          document.body.prepend(el);
        }
        el.textContent = `Live Relay session ${id} — this is the paused teller window, not a new login.`;
      }, this.id)
      .catch(() => undefined);
  }

  async resume(): Promise<void> {
    this.owner = "automation";
    await this.page
      ?.evaluate(() => document.getElementById("relay-live-session")?.remove())
      .catch(() => undefined);
  }

  async observe(): Promise<Observation> {
    const page = this.requirePage();
    await this.settle();
    const texts: string[] = [];
    const arias: string[] = [];
    for (const frame of page.frames()) {
      if (skipFrame(frame.url())) continue;
      if ((await frame.locator("frameset").count()) > 0) continue;
      const body = frame.locator("body");
      if ((await body.count()) === 0) continue;
      const text = await body.innerText({ timeout: 1_000 }).catch(() => "");
      if (text.trim()) texts.push(text);
      const snap = await body.ariaSnapshot({ timeout: 1_000 }).catch(() => "");
      if (snap.trim()) arias.push(snap);
    }
    const aria = arias.join("\n");
    const text = texts.join("\n");
    this.lastRefs = parseAriaRefs(aria);
    if (this.lastRefs.length === 0) {
      this.lastRefs = await this.fallbackRefs();
    }
    let dialog: string | undefined;
    for (const frame of page.frames()) {
      if (skipFrame(frame.url())) continue;
      const dialogLoc = frame.getByRole("dialog");
      if ((await dialogLoc.count()) > 0) {
        dialog =
          (await dialogLoc.first().getAttribute("aria-label")) ??
          (await dialogLoc.first().innerText()).slice(0, 80);
        break;
      }
    }
    return {
      url: page.url(),
      title: await page.title(),
      aria,
      text,
      refs: this.lastRefs,
      dialog,
    };
  }

  resolveRef(ref: string): Locator | undefined {
    const hit = this.lastRefs.find((r) => r.ref === ref);
    if (!hit) return undefined;
    return { by: "role", role: hit.role, name: hit.name };
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

  private async perform(action: Action): Promise<ActionResult> {
    const page = this.requirePage();
    try {
      if (action.name === "navigate") {
        if (!action.url) return { ok: false, error: "navigate requires url" };
        const response = await page.goto(action.url, { waitUntil: "domcontentloaded", timeout: action.timeoutMs ?? 8000 });
        await this.settle();
        const status = response?.status() ?? 0;
        if (status >= 500) {
          return { ok: false, error: `HTTP ${status}`, retryable: true };
        }
        return { ok: true };
      }
      if (action.name === "wait") {
        await page.waitForTimeout(Number(action.value ?? 500));
        return { ok: true };
      }
      if (action.name === "dismiss") {
        const target = action.target ?? {
          primary: { by: "role" as const, role: "button", name: "Dismiss" },
        };
        const located = await this.resolveTarget(target);
        if (!located?.handle) return { ok: true };
        await located.handle.click();
        await this.settle();
        return { ok: true, usedLocator: located.locator };
      }

      if (!action.target) return { ok: false, error: `${action.name} requires a target` };
      const located = await this.resolveTarget(action.target);
      if (!located?.handle) {
        return { ok: false, error: `No locator matched for ${action.name}` };
      }
      const handle = located.handle;
      const row = await readRow(handle);

      if (action.name === "click") {
        const frameset = page.frames().some((frame) => frame.name() === "nav" || frame.name() === "work");
        await handle.click({ timeout: action.timeoutMs, noWaitAfter: frameset });
        if (frameset) {
          const work = page.frame({ name: "work" });
          await work?.waitForLoadState("domcontentloaded").catch(() => undefined);
        }
        await this.settle();
        return { ok: true, usedLocator: located.locator, row };
      }
      if (action.name === "type") {
        await handle.fill(action.value ?? "", { timeout: action.timeoutMs });
        await this.settle();
        return { ok: true, usedLocator: located.locator, row };
      }
      if (action.name === "select") {
        try {
          await handle.selectOption({ label: action.value ?? "" }, { timeout: action.timeoutMs });
        } catch {
          await handle.selectOption(action.value ?? "", { timeout: action.timeoutMs });
        }
        await this.settle();
        return { ok: true, usedLocator: located.locator, row };
      }
      if (action.name === "extract") {
        const extracted = await readExtractedValue(
          handle,
          located.locator.name ?? located.locator.text ?? action.target?.primary.cell ?? action.target?.primary.name,
        );
        return { ok: true, extracted, usedLocator: located.locator, row };
      }
      return { ok: false, error: `Unsupported action ${action.name}` };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (/ERR_BLOCKED_BY_CLIENT|blockedbyclient/i.test(error)) {
        return { ok: false, error: "policy: request blocked by route allowlist" };
      }
      const retryable = /timeout|timed out|net::ERR|503|502|500/i.test(error);
      return { ok: false, error, retryable };
    }
  }

  async screenshot(): Promise<Buffer> {
    return this.requirePage().screenshot({ fullPage: true });
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.page = null;
    this.context = null;
    this.browser = null;
  }

  private async resolveTarget(target: Target): Promise<{ handle: Awaited<ReturnType<typeof locateInFrames>>; locator: Locator } | null> {
    const page = this.requirePage();
    const chain = [target.primary, ...(target.fallbacks ?? [])];
    for (const locator of chain) {
      const handle = await locateInFrames(page, locator);
      if (handle) return { handle, locator };
    }
    return null;
  }

  private async settle(): Promise<void> {
    const page = this.requirePage();
    await page.waitForLoadState("domcontentloaded", { timeout: 1_500 }).catch(() => undefined);
    await page.waitForTimeout(80);
  }

  private async fallbackRefs(): Promise<InteractiveRef[]> {
    const page = this.requirePage();
    const names = [
      "Member ID",
      "Search",
      "Dismiss",
      "Open Sub-Account",
      "Disputes",
      "Dispute ID",
      "Open",
      "Details",
      "Next",
      "Username",
      "Password",
      "Sign In",
      "Last Name",
      "Open Row",
      "Open by ID",
      "File Dispute",
      "File Dispute Now",
      "Reason",
      "Continue",
      "Continue to Review",
      "Confirm",
      "Confirm Filing",
      "I attest",
      "Product",
    ];
    const refs: InteractiveRef[] = [];
    for (const [i, name] of names.entries()) {
      for (const frame of page.frames()) {
        if (skipFrame(frame.url())) continue;
        const button = frame.getByRole("button", { name });
        const link = frame.getByRole("link", { name });
        const box = frame.getByRole("textbox", { name });
        const combo = frame.getByRole("combobox", { name });
        if (await button.count()) {
          refs.push({ ref: `r${i}`, role: "button", name });
          break;
        }
        if (await link.count()) {
          refs.push({ ref: `r${i}`, role: "link", name });
          break;
        }
        if (await box.count()) {
          refs.push({ ref: `r${i}`, role: "textbox", name });
          break;
        }
        if (await combo.count()) {
          refs.push({ ref: `r${i}`, role: "combobox", name });
          break;
        }
      }
    }
    return refs;
  }

  private requirePage(): Page {
    if (!this.page) throw new Error("WebSurface has not been launched.");
    return this.page;
  }
}

function skipFrame(url: string): boolean {
  return url.includes("/ticker") || url === "about:blank";
}

function dockerChromeExecutable(): string | undefined {
  const explicit = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?.trim();
  if (explicit) return explicit;
  if (!existsSync("/.dockerenv")) return undefined;
  const root = "/ms-playwright";
  if (!existsSync(root)) return undefined;
  for (const entry of readdirSync(root)) {
    if (!entry.startsWith("chromium-") || entry.includes("headless")) continue;
    const base = join(root, entry);
    for (const arch of readdirSync(base)) {
      const chrome = join(base, arch, "chrome");
      if (existsSync(chrome)) return chrome;
    }
  }
  return undefined;
}

function chromiumLaunchArgs(): string[] {
  const args = ["--no-sandbox", "--disable-dev-shm-usage"];
  if (existsSync("/.dockerenv")) {
    args.push("--disable-gpu", "--disable-software-rasterizer");
  }
  return args;
}

async function readRow(
  handle: NonNullable<Awaited<ReturnType<typeof locateInFrames>>>,
): Promise<{ headers: string[]; cells: string[] } | undefined> {
  try {
    return await handle.evaluate((el) => {
      const row = el.closest("tr");
      if (!row) return undefined;
      const table = row.closest("table");
      const headers = table
        ? Array.from(table.querySelectorAll("th")).map((th) => (th.textContent ?? "").trim())
        : [];
      const cells = Array.from(row.querySelectorAll("td")).map((td) => (td.textContent ?? "").trim());
      if (cells.length === 0) return undefined;
      return { headers, cells };
    });
  } catch {
    return undefined;
  }
}

async function readExtractedValue(
  handle: NonNullable<Awaited<ReturnType<typeof locateInFrames>>>,
  label?: string,
): Promise<string> {
  let extracted = ((await handle.innerText()) || (await handle.inputValue().catch(() => ""))).trim();
  // Hostile tables often expose the same accessible name on the <th> and the <td>.
  // If we landed on the header, take the adjacent value cell.
  if (label && extracted === label) {
    const sibling = handle.locator("xpath=following-sibling::td[1]");
    if ((await sibling.count()) > 0) {
      const value = (await sibling.innerText()).trim();
      if (value) extracted = value;
    }
  }
  return extracted;
}
