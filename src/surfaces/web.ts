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
import { locateInFrames, parseAriaRefs } from "./locators.ts";

export type WebSurfaceOptions = {
  headed?: boolean;
  startUrl?: string;
};

export class WebSurface implements Surface {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private owner: ControlOwner = "automation";
  private lastRefs: InteractiveRef[] = [];

  constructor(private readonly options: WebSurfaceOptions = {}) {}

  async launch(): Promise<void> {
    this.browser = await chromium.launch({
      headless: this.options.headed ? false : true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    this.context = await this.browser.newContext({ viewport: { width: 1100, height: 800 } });
    this.context.setDefaultTimeout(8_000);
    this.page = await this.context.newPage();
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
  }

  async resume(): Promise<void> {
    this.owner = "automation";
  }

  async observe(): Promise<Observation> {
    const page = this.requirePage();
    await this.settle();
    let aria = "";
    try {
      aria = await page.locator("body").ariaSnapshot();
    } catch {
      aria = await page.innerText("body");
    }
    this.lastRefs = parseAriaRefs(aria);
    if (this.lastRefs.length === 0) {
      this.lastRefs = await this.fallbackRefs();
    }
    const dialogLoc = page.getByRole("dialog");
    const dialog =
      (await dialogLoc.count()) > 0
        ? ((await dialogLoc.first().getAttribute("aria-label")) ?? (await dialogLoc.first().innerText()).slice(0, 80))
        : undefined;
    return {
      url: page.url(),
      title: await page.title(),
      aria,
      text: await page.innerText("body").catch(() => ""),
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
    const page = this.requirePage();
    try {
      if (action.name === "navigate") {
        if (!action.url) return { ok: false, error: "navigate requires url" };
        await page.goto(action.url, { waitUntil: "domcontentloaded" });
        await this.settle();
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

      if (action.name === "click") {
        await handle.click();
        await this.settle();
        return { ok: true, usedLocator: located.locator };
      }
      if (action.name === "type") {
        await handle.fill(action.value ?? "");
        await this.settle();
        return { ok: true, usedLocator: located.locator };
      }
      if (action.name === "select") {
        try {
          await handle.selectOption({ label: action.value ?? "" });
        } catch {
          await handle.selectOption(action.value ?? "");
        }
        await this.settle();
        return { ok: true, usedLocator: located.locator };
      }
      if (action.name === "extract") {
        const extracted = await readExtractedValue(handle, action.target?.primary.name);
        return { ok: true, extracted, usedLocator: located.locator };
      }
      return { ok: false, error: `Unsupported action ${action.name}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
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
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    await page.waitForTimeout(150);
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
      "File Dispute",
      "Reason",
      "Continue",
      "Confirm",
      "Product",
    ];
    const refs: InteractiveRef[] = [];
    for (const [i, name] of names.entries()) {
      const button = page.getByRole("button", { name });
      const link = page.getByRole("link", { name });
      const box = page.getByRole("textbox", { name });
      const combo = page.getByRole("combobox", { name });
      if (await button.count()) refs.push({ ref: `r${i}`, role: "button", name });
      else if (await link.count()) refs.push({ ref: `r${i}`, role: "link", name });
      else if (await box.count()) refs.push({ ref: `r${i}`, role: "textbox", name });
      else if (await combo.count()) refs.push({ ref: `r${i}`, role: "combobox", name });
    }
    return refs;
  }

  private requirePage(): Page {
    if (!this.page) throw new Error("WebSurface has not been launched.");
    return this.page;
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
