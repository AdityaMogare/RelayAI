import { describe, expect, it } from "vitest";
import { CardActionsStore, DuplicateCardActionError, UnsupportedCardSqlError } from "../apps/bank-console/card-actions.ts";

describe("card_actions ledger", () => {
  it("enforces a unique (member_id, last4) and proves the count in sqlite", () => {
    const store = new CardActionsStore();
    store.insert({ member_id: "12345", last4: "4412" });
    expect(() => store.insert({ member_id: "12345", last4: "4412" })).toThrow(DuplicateCardActionError);
    expect(store.exec("SELECT count(*) FROM card_actions WHERE member_id='12345' AND last4='4412'")).toEqual({
      assertion: "count of card actions for 12345 / 4412",
      note: "SQLite core ledger (node:sqlite, in-memory). This is the query a real core would run.",
      engine: "node:sqlite",
      sql: "SELECT count(*) FROM card_actions WHERE member_id='12345' AND last4='4412'",
      count: 1,
    });
  });

  it("rejects SQL that is not the count query", () => {
    const store = new CardActionsStore();
    expect(() => store.exec("DELETE FROM card_actions")).toThrow(UnsupportedCardSqlError);
  });
});
