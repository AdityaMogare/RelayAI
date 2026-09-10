import type { Surface } from "../core/surface.ts";
import type { Action, ActionResult, ControlOwner, Locator, Observation } from "../core/types.ts";
import { locatorChain, locatorName } from "../replay/locator.ts";

export type MockPage =
  | "search"
  | "notice"
  | "detail"
  | "notfound"
  | "denied"
  | "expired"
  | "wrong"
  | "unavailable"
  | "confirm"
  | "opened"
  | "disputes"
  | "disputeDetail"
  | "disputeEmptyAmount"
  | "disputeNotFound"
  | "disputeAlreadyFiled"
  | "disputeForm"
  | "disputeReview"
  | "disputeFiled";

export class MockSurface implements Surface {
  page: MockPage;
  memberId = "";
  product = "";
  disputeId = "";
  reason = "";
  private owner: ControlOwner = "automation";
  private readonly id = "mock-session";
  failNextLocator = false;
  /** Skip rank-1 and match the first fallback — used to prove drift detection. */
  skipPrimary = false;
  /** Fail the first action whose resolved name matches (case-insensitive). */
  failWhenName?: string;
  /** Dismiss does not clear the interstitial — recoverable budget exhausts. */
  stickyNotice = false;
  /** Navigate/search returns HTTP 503 this many times before succeeding. */
  failTransientTimes = 0;
  /** CU-West style copy remaps on the fake UI (Search → Find Member). */
  labels: Record<string, string>;

  constructor(start: MockPage = "search", labels: Record<string, string> = {}) {
    this.page = start;
    this.labels = labels;
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
    return this.snapshot();
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
    if (this.failNextLocator) {
      this.failNextLocator = false;
      return { ok: false, error: "No locator matched" };
    }
    if (action.name === "navigate") {
      if (this.failTransientTimes > 0) {
        this.failTransientTimes -= 1;
        this.page = "unavailable";
        return { ok: false, error: "HTTP 503", retryable: true };
      }
      if (action.url?.includes("expired")) this.page = "expired";
      else if (action.url?.includes("wrong")) this.page = "wrong";
      else if (action.url?.includes("flaky") || action.url?.includes("unavailable")) this.page = "unavailable";
      else this.page = action.url?.includes("notice=always") || this.stickyNotice ? "notice" : "search";
      return { ok: true };
    }
    if (action.name === "wait") return { ok: true };

    const used = this.resolveLocator(action);
    const name = this.canonical(locatorName(used ?? action.target?.primary ?? { by: "role" }));
    if (this.failWhenName && name === this.failWhenName.toLowerCase()) {
      this.failWhenName = undefined;
      return { ok: false, error: "No locator matched" };
    }

    if (action.name === "dismiss") {
      if (this.page === "notice" && !this.stickyNotice) this.page = "search";
      return { ok: true, usedLocator: used ?? { by: "role", role: "button", name: "Dismiss" } };
    }

    if (action.target && !used) {
      return { ok: false, error: "No locator matched" };
    }

    if (action.name === "type" && name === "member id") {
      this.memberId = action.value ?? "";
      return { ok: true, usedLocator: used };
    }
    if (action.name === "type" && name === "dispute id") {
      this.disputeId = action.value ?? "";
      return { ok: true, usedLocator: used };
    }
    if (action.name === "select" && name === "product") {
      this.product = action.value ?? "";
      return { ok: true, usedLocator: used };
    }
    if (action.name === "select" && name === "reason") {
      this.reason = action.value ?? "";
      return { ok: true, usedLocator: used };
    }
    if (action.name === "click" && (name === "search" || name.startsWith("search"))) {
      if (this.failTransientTimes > 0) {
        this.failTransientTimes -= 1;
        this.page = "unavailable";
        return { ok: false, error: "HTTP 503", retryable: true };
      }
      const q = this.memberId.trim().toLowerCase();
      if (this.memberId === "99999") this.page = "notfound";
      else if (this.memberId === "55555") this.page = "denied";
      else if (this.memberId === "00000") this.page = "expired";
      else if (q === "jane doe" || this.memberId === "12345" || !this.memberId) this.page = "detail";
      else this.page = "notfound";
      return { ok: true, usedLocator: used };
    }
    if (action.name === "click" && name.includes("open sub-account")) {
      this.page = "confirm";
      return { ok: true, usedLocator: used };
    }
    if (action.name === "click" && (name === "disputes" || name === "card disputes")) {
      this.page = "disputes";
      return { ok: true, usedLocator: used };
    }
    if (action.name === "click" && (name === "open" || name === "open row" || name === "details" || used?.by === "cellInRow")) {
      const scoped =
        action.target?.primary.scope?.by === "row" ? action.target.primary.scope.hasText : [];
      const scope = [
        ...scoped,
        action.target?.primary.row?.matches ?? "",
      ]
        .join(" ")
        .toLowerCase();
      const fromScope = scope.toUpperCase().match(/DSP-\d+/)?.[0];
      if (fromScope) this.disputeId = fromScope;
      const row = {
        headers: ["ID", "Merchant", "Card", "Amount", "Status", ""],
        cells: ["DSP-1001", "ACME POS", "4412", "$42.18", "open", "Open"],
      };
      if (this.disputeId === "DSP-9999" || /no-such|unknown/.test(scope)) {
        return { ok: false, error: "No locator matched for click" };
      }
      if (this.disputeId === "DSP-1002" || /northside/.test(scope)) this.page = "disputeAlreadyFiled";
      else if (this.disputeId === "DSP-1003" || /mainframe/.test(scope)) this.page = "disputeEmptyAmount";
      else this.page = "disputeDetail";
      if (/northside/.test(scope)) row.cells = ["DSP-1002", "NORTHSIDE FUEL", "4412", "$61.02", "filed", "Open"];
      if (/mainframe/.test(scope)) row.cells = ["DSP-1003", "MAINFRAME TIMEOUT", "4412", "", "open", "Open"];
      return { ok: true, usedLocator: used, row };
    }
    if (action.name === "click" && name.includes("file dispute")) {
      this.page = "disputeForm";
      return { ok: true, usedLocator: used };
    }
    if (action.name === "click" && (name === "continue" || name.startsWith("continue"))) {
      if (this.page === "disputeForm") this.page = "disputeReview";
      return { ok: true, usedLocator: used };
    }
    if (action.name === "click" && (name === "confirm" || name.startsWith("confirm") || name === this.label("Confirm").toLowerCase())) {
      this.page = this.page === "disputeReview" ? "disputeFiled" : "opened";
      return { ok: true, usedLocator: used };
    }
    if (action.name === "extract") {
      return this.extract(action, used);
    }
    return { ok: false, error: `Unhandled mock action ${action.name} ${name}` };
  }

  async screenshot(): Promise<Buffer> {
    return Buffer.from("mock-screenshot");
  }

  async close(): Promise<void> {}

  private extract(action: Action, used?: Locator): ActionResult {
    const locName = locatorName(used ?? action.target?.primary ?? { by: "role" }).toLowerCase();
    const hit = used ?? action.target?.primary;
    if (this.page === "opened") {
      return {
        ok: true,
        extracted: "Confirmation: Share Savings is now open",
        usedLocator: hit,
      };
    }
    if (this.page === "disputeFiled") {
      return {
        ok: true,
        extracted: "Confirmation: Dispute DSP-1001 filed (Unauthorized). Case CASE-77201.",
        usedLocator: hit,
      };
    }
    if (this.page === "disputeEmptyAmount") {
      return { ok: true, extracted: "", usedLocator: action.target?.primary };
    }
    if (this.page === "disputeDetail" || this.page === "disputeAlreadyFiled") {
      if (locName.includes("merchant")) {
        return { ok: true, extracted: "ACME POS", usedLocator: hit };
      }
      if (locName.includes("amount")) {
        return { ok: true, extracted: "$42.18", usedLocator: hit };
      }
      return { ok: true, extracted: "$42.18", usedLocator: hit };
    }
    if (this.page === "detail") {
      return { ok: true, extracted: "$4,250.00", usedLocator: hit };
    }
    return { ok: false, error: "Extract target not visible" };
  }

  private label(name: string): string {
    return this.labels[name] ?? name;
  }

  private canonical(displayed: string): string {
    const lower = displayed.toLowerCase();
    for (const [from, to] of Object.entries(this.labels)) {
      if (to.toLowerCase() === lower) return from.toLowerCase();
    }
    return lower;
  }

  private resolveLocator(action: Action): Locator | undefined {
    if (!action.target) return undefined;
    const chain = locatorChain(action.target);
    const start = this.skipPrimary ? 1 : 0;
    const relabelled = Object.keys(this.labels).length > 0;
    for (const locator of chain.slice(start)) {
      const want = locatorName(locator);
      if (!want) continue;
      if (!relabelled) return locator;
      if (this.locatorVisible(locator)) return locator;
    }
    return undefined;
  }

  private locatorVisible(locator: Locator): boolean {
    const want = locatorName(locator);
    if (!want) return false;
    const snap = this.snapshot();
    if (locator.by === "text" || locator.by === "css") {
      return `${snap.aria}\n${snap.text}`.toLowerCase().includes(want.toLowerCase());
    }
    return snap.aria.includes(`"${want}"`);
  }

  private snapshot(): Observation {
    const base = {
      refs: [] as Observation["refs"],
      title: "Relay Credit Union — Member Servicing",
    };
    if (this.page === "notice") {
      return {
        ...base,
        url: "http://127.0.0.1:3000/?notice=1",
        aria: '- dialog "System Notice"\n  - button "Dismiss"',
        text: "System Notice Scheduled core maintenance",
        dialog: "System Notice",
      };
    }
    if (this.page === "notfound") {
      return {
        ...base,
        url: "http://127.0.0.1:3000/search?mid=99999",
        title: "Relay Credit Union — Member not found",
        aria: '- alert "Member not found"',
        text: "Member not found No member record matches the ID provided (99999).",
      };
    }
    if (this.page === "denied") {
      return {
        ...base,
        url: "http://127.0.0.1:3000/search?mid=55555",
        title: "Relay Credit Union — Access denied",
        aria: '- alert "Permission denied"',
        text: "Permission denied You are not authorized to view member 55555.",
      };
    }
    if (this.page === "expired") {
      return {
        ...base,
        url: "http://127.0.0.1:3000/?expired=1",
        title: "Relay Credit Union — Session expired",
        aria: '- alert "Session expired"',
        text: "Session expired Your teller session has timed out.",
      };
    }
    if (this.page === "wrong") {
      return {
        ...base,
        url: "http://127.0.0.1:3000/?wrong=1",
        title: "Relay Credit Union — Wrong screen",
        aria: '- alert "Wrong screen"',
        text: "Wrong screen This is the teller training sandbox, not member servicing.",
      };
    }
    if (this.page === "unavailable") {
      return {
        ...base,
        url: "http://127.0.0.1:3000/?flaky=1",
        title: "Relay Credit Union — Unavailable",
        aria: '- alert "Core temporarily unavailable"',
        text: "Core temporarily unavailable The servicing host returned HTTP 503.",
      };
    }
    if (this.page === "disputeEmptyAmount") {
      return {
        ...base,
        url: "http://127.0.0.1:3000/member/12345/disputes/DSP-1003",
        title: "Relay Credit Union — Dispute DSP-1003",
        aria: '- heading "Dispute DSP-1003"\n- cell "Transaction Amount"',
        text: "Dispute DSP-1003 Merchant ACME POS Transaction Amount File Dispute",
      };
    }
    if (this.page === "detail") {
      return {
        ...base,
        url: "http://127.0.0.1:3000/member/12345",
        title: "Relay Credit Union — Member 12345",
        aria: `- heading "Member 12345"\n- cell "Savings Balance"\n- link "${this.label("Disputes")}"\n- link "Open Sub-Account"`,
        text: `Member 12345 Name Jane Doe Savings Balance $4,250.00 Checking Balance $1,102.33 ${this.label("Disputes")}`,
      };
    }
    if (this.page === "disputes") {
      return {
        ...base,
        url: "http://127.0.0.1:3000/member/12345/disputes",
        title: "Relay Credit Union — Dispute Queue",
        aria: `- heading "Dispute Queue"\n- link "${this.label("Open")}"\n- link "${this.label("Open")}"`,
        text: `Dispute Queue Member 12345 ACME POS 4412 $42.18 NORTHSIDE FUEL 4412 ACME WHOLESALE 4412 ${this.label("Open")}`,
        dialog: this.labels.attest ? "Supervisor Attestation" : undefined,
      };
    }
    if (this.page === "disputeNotFound") {
      return {
        ...base,
        url: "http://127.0.0.1:3000/member/12345/disputes/DSP-9999",
        title: "Relay Credit Union — Dispute not found",
        aria: '- alert "Dispute not found"',
        text: "Dispute not found No dispute DSP-9999 exists for member 12345.",
      };
    }
    if (this.page === "disputeAlreadyFiled") {
      return {
        ...base,
        url: "http://127.0.0.1:3000/member/12345/disputes/DSP-1002",
        title: "Relay Credit Union — Dispute DSP-1002",
        aria: '- alert "Dispute already filed"\n- cell "Transaction Amount"',
        text: "Dispute already filed Case CASE-66110 is already in review. Transaction Amount $61.02",
      };
    }
    if (this.page === "disputeDetail") {
      return {
        ...base,
        url: "http://127.0.0.1:3000/member/12345/disputes/DSP-1001",
        title: "Relay Credit Union — Dispute DSP-1001",
        aria: '- heading "Dispute DSP-1001"\n- cell "Transaction Amount"\n- link "' +
          this.label("File Dispute") +
          '"',
        text: `Dispute DSP-1001 Merchant ACME POS Transaction Amount $42.18 ${this.label("File Dispute")}`,
      };
    }
    if (this.page === "disputeForm") {
      return {
        ...base,
        url: "http://127.0.0.1:3000/member/12345/disputes/DSP-1001/file",
        title: "Relay Credit Union — File Card Dispute",
        aria: `- heading "File Card Dispute"\n- combobox "Reason"\n- button "${this.label("Continue")}"`,
        text: "File Card Dispute Reason Continue",
      };
    }
    if (this.page === "disputeReview") {
      return {
        ...base,
        url: "http://127.0.0.1:3000/member/12345/disputes/DSP-1001/file?step=review",
        title: "Relay Credit Union — Confirm Dispute Filing",
        aria: `- heading "Confirm Dispute Filing"\n- button "${this.label("Confirm")}"`,
        text: `Confirm Dispute Filing Filing DSP-1001 for $42.18. This action is irreversible once confirmed. ${this.label("Confirm")}`,
      };
    }
    if (this.page === "disputeFiled") {
      return {
        ...base,
        url: "http://127.0.0.1:3000/member/12345/disputes/DSP-1001/receipt",
        title: "Relay Credit Union — Dispute filed",
        aria: '- status "Confirmation"',
        text: "Dispute filed Confirmation: Dispute DSP-1001 filed (Unauthorized). Case CASE-77201.",
      };
    }
    if (this.page === "opened") {
      return {
        ...base,
        url: "http://127.0.0.1:3000/member/12345/sub-account/opened",
        title: "Relay Credit Union — Sub-account opened",
        aria: '- status "Confirmation"',
        text: "Sub-account opened Confirmation: Share Savings is now open for member 12345.",
      };
    }
    if (this.page === "confirm") {
      return {
        ...base,
        url: "http://127.0.0.1:3000/member/12345/sub-account?step=review",
        title: "Relay Credit Union — Confirm sub-account",
        aria: `- combobox "Product"\n- button "Continue"\n- button "${this.label("Confirm")}"`,
        text: `Confirm opening a sub-account. Product Continue ${this.label("Confirm")}`,
      };
    }
    return {
      ...base,
      url: "http://127.0.0.1:3000/",
      aria: `- textbox "${this.label("Member ID")}"\n- button "${this.label("Search")}"`,
        text: `${this.label("Member Lookup")} ${this.label("Member ID")} ${this.label("Search")}`,
    };
  }
}
