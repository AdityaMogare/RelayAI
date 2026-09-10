import type { Surface } from "../core/surface.ts";
import type { Action, ActionResult, ControlOwner, Locator, Observation } from "../core/types.ts";

export type MockPage =
  | "search"
  | "notice"
  | "detail"
  | "notfound"
  | "denied"
  | "expired"
  | "confirm"
  | "opened"
  | "disputes"
  | "disputeDetail"
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
  failNextLocator = false;

  constructor(start: MockPage = "search") {
    this.page = start;
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
    if (this.failNextLocator) {
      this.failNextLocator = false;
      return { ok: false, error: "No locator matched" };
    }
    if (action.name === "navigate") {
      this.page = action.url?.includes("expired") ? "expired" : "search";
      return { ok: true };
    }
    if (action.name === "wait") return { ok: true };
    if (action.name === "dismiss") {
      if (this.page === "notice") this.page = "search";
      return { ok: true, usedLocator: { by: "role", role: "button", name: "Dismiss" } };
    }

    const name = action.target?.primary.name ?? "";
    if (action.name === "type" && this.matches(action.target?.primary, "Member ID")) {
      this.memberId = action.value ?? "";
      return { ok: true, usedLocator: action.target?.primary };
    }
    if (action.name === "type" && this.matches(action.target?.primary, "Dispute ID")) {
      this.disputeId = action.value ?? "";
      return { ok: true, usedLocator: action.target?.primary };
    }
    if (action.name === "select" && this.matches(action.target?.primary, "Product")) {
      this.product = action.value ?? "";
      return { ok: true };
    }
    if (action.name === "select" && this.matches(action.target?.primary, "Reason")) {
      this.reason = action.value ?? "";
      return { ok: true };
    }
    if (action.name === "click" && this.matches(action.target?.primary, "Search")) {
      if (this.memberId === "99999") this.page = "notfound";
      else if (this.memberId === "55555") this.page = "denied";
      else if (this.memberId === "00000") this.page = "expired";
      else this.page = "detail";
      return { ok: true, usedLocator: action.target?.primary };
    }
    if (action.name === "click" && name.toLowerCase().includes("open sub-account")) {
      this.page = "confirm";
      return { ok: true };
    }
    if (action.name === "click" && this.matches(action.target?.primary, "Disputes")) {
      this.page = "disputes";
      return { ok: true };
    }
    if (action.name === "click" && this.matches(action.target?.primary, "Open")) {
      if (this.disputeId === "DSP-9999") this.page = "disputeNotFound";
      else if (this.disputeId === "DSP-1002") this.page = "disputeAlreadyFiled";
      else this.page = "disputeDetail";
      return { ok: true };
    }
    if (action.name === "click" && this.matches(action.target?.primary, "File Dispute")) {
      this.page = "disputeForm";
      return { ok: true };
    }
    if (action.name === "click" && name.toLowerCase() === "continue") {
      if (this.page === "disputeForm") this.page = "disputeReview";
      return { ok: true };
    }
    if (action.name === "click" && name.toLowerCase() === "confirm") {
      this.page = this.page === "disputeReview" ? "disputeFiled" : "opened";
      return { ok: true };
    }
    if (action.name === "extract") {
      return this.extract(action);
    }
    return { ok: false, error: `Unhandled mock action ${action.name} ${name}` };
  }

  async screenshot(): Promise<Buffer> {
    return Buffer.from("mock-screenshot");
  }

  async close(): Promise<void> {}

  private extract(action: Action): ActionResult {
    const locName = (action.target?.primary.name ?? "").toLowerCase();
    if (this.page === "opened") {
      return {
        ok: true,
        extracted: "Confirmation: Share Savings is now open",
        usedLocator: action.target?.primary,
      };
    }
    if (this.page === "disputeFiled") {
      return {
        ok: true,
        extracted: "Confirmation: Dispute DSP-1001 filed (Unauthorized). Case CASE-77201.",
        usedLocator: action.target?.primary,
      };
    }
    if (this.page === "disputeDetail" || this.page === "disputeAlreadyFiled") {
      if (locName.includes("merchant")) {
        return { ok: true, extracted: "ACME POS", usedLocator: action.target?.primary };
      }
      if (locName.includes("amount")) {
        return { ok: true, extracted: "$42.18", usedLocator: action.target?.primary };
      }
      return { ok: true, extracted: "$42.18", usedLocator: action.target?.primary };
    }
    if (this.page === "detail") {
      return { ok: true, extracted: "$4,250.00", usedLocator: action.target?.primary };
    }
    return { ok: false, error: "Extract target not visible" };
  }

  private matches(locator: Locator | undefined, name: string): boolean {
    if (!locator) return false;
    return (locator.name ?? locator.text ?? "").toLowerCase() === name.toLowerCase();
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
    if (this.page === "detail") {
      return {
        ...base,
        url: "http://127.0.0.1:3000/member/12345",
        title: "Relay Credit Union — Member 12345",
        aria: '- heading "Member 12345"\n- cell "Savings Balance"\n- link "Disputes"',
        text: "Member 12345 Name Jane Doe Savings Balance $4,250.00 Checking Balance $1,102.33 Disputes",
      };
    }
    if (this.page === "disputes") {
      return {
        ...base,
        url: "http://127.0.0.1:3000/member/12345/disputes",
        title: "Relay Credit Union — Dispute Queue",
        aria: '- heading "Dispute Queue"\n- textbox "Dispute ID"\n- button "Open"',
        text: "Dispute Queue Member 12345 Dispute ID Open DSP-1001 ACME POS $42.18",
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
        aria: '- heading "Dispute DSP-1001"\n- cell "Transaction Amount"\n- link "File Dispute"',
        text: "Dispute DSP-1001 Merchant ACME POS Transaction Amount $42.18 File Dispute",
      };
    }
    if (this.page === "disputeForm") {
      return {
        ...base,
        url: "http://127.0.0.1:3000/member/12345/disputes/DSP-1001/file",
        title: "Relay Credit Union — File Card Dispute",
        aria: '- heading "File Card Dispute"\n- combobox "Reason"\n- button "Continue"',
        text: "File Card Dispute Reason Continue",
      };
    }
    if (this.page === "disputeReview") {
      return {
        ...base,
        url: "http://127.0.0.1:3000/member/12345/disputes/DSP-1001/file?step=review",
        title: "Relay Credit Union — Confirm Dispute Filing",
        aria: '- heading "Confirm Dispute Filing"\n- button "Confirm"',
        text: "Confirm Dispute Filing Filing DSP-1001 for $42.18. This action is irreversible once confirmed.",
      };
    }
    if (this.page === "disputeFiled") {
      return {
        ...base,
        url: "http://127.0.0.1:3000/member/12345/disputes/DSP-1001/submit",
        title: "Relay Credit Union — Dispute filed",
        aria: '- status "Confirmation"',
        text: "Dispute filed Confirmation: Dispute DSP-1001 filed (Unauthorized). Case CASE-77201.",
      };
    }
    if (this.page === "opened") {
      return {
        ...base,
        url: "http://127.0.0.1:3000/member/12345/sub-account/confirm",
        title: "Relay Credit Union — Sub-account opened",
        aria: '- status "Confirmation"',
        text: "Sub-account opened Confirmation: Share Savings is now open for member 12345.",
      };
    }
    return {
      ...base,
      url: "http://127.0.0.1:3000/",
      aria: '- textbox "Member ID"\n- button "Search"',
      text: "Member Lookup Member ID Search",
    };
  }
}
