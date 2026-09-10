import { describe, expect, it } from "vitest";
import { FilingsStore } from "../apps/bank-console/filings.ts";
import { DuplicateFilingError, UnsupportedSqlError } from "../src/core/errors.ts";

describe("filings ledger", () => {
  it("enforces a unique dispute_id and proves the count in sqlite", () => {
    const store = new FilingsStore();
    store.insert({ dispute_id: "DSP-1001", member_id: "12345", reason: "Unauthorized" });
    expect(() =>
      store.insert({ dispute_id: "DSP-1001", member_id: "12345", reason: "Unauthorized" }),
    ).toThrow(DuplicateFilingError);
    store.insert({ dispute_id: "DSP-1002", member_id: "12345", reason: "Duplicate" });
    expect(store.exec("SELECT count(*) FROM filings WHERE dispute_id='DSP-1001'")).toEqual({
      assertion: "count of filings for DSP-1001",
      note: "SQLite core ledger (node:sqlite, in-memory). This is the query a real core would run.",
      engine: "node:sqlite",
      sql: "SELECT count(*) FROM filings WHERE dispute_id='DSP-1001'",
      count: 1,
    });
  });

  it("records a sub-account open as a write", () => {
    const store = new FilingsStore();
    store.insertSubAccount({ member_id: "12345", product: "Share Savings" });
    expect(store.exec("SELECT count(*) FROM sub_accounts WHERE member_id='12345'").count).toBe(1);
  });

  it("rejects SQL that is not the count query", () => {
    const store = new FilingsStore();
    expect(() => store.exec("DELETE FROM filings")).toThrow(UnsupportedSqlError);
  });
});
