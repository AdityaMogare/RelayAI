import { DatabaseSync } from "node:sqlite";
import { DuplicateFilingError, UnsupportedSqlError } from "../../src/core/errors.ts";

export type Filing = {
  id: number;
  dispute_id: string;
  member_id: string;
  reason: string;
  filed_at: string;
};

export type SubAccount = {
  id: number;
  member_id: string;
  product: string;
  opened_at: string;
};

export type CountProof = {
  assertion: string;
  note: string;
  engine: "node:sqlite";
  sql: string;
  count: number;
};

/**
 * SQLite core ledger (node:sqlite, in-memory). Unique on dispute_id so a second
 * Confirm is a core rejection, not only an automation-ledger conflict.
 */
export class FilingsStore {
  private readonly db: DatabaseSync;

  constructor() {
    this.db = new DatabaseSync(":memory:");
    this.db.exec(`
      CREATE TABLE filings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dispute_id TEXT NOT NULL UNIQUE,
        member_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        filed_at TEXT NOT NULL
      );
      CREATE TABLE sub_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id TEXT NOT NULL,
        product TEXT NOT NULL,
        opened_at TEXT NOT NULL
      );
    `);
  }

  insert(row: { dispute_id: string; member_id: string; reason: string; filed_at?: string }): Filing {
    const filed_at = row.filed_at ?? new Date().toISOString();
    try {
      this.db
        .prepare(
          "INSERT INTO filings (dispute_id, member_id, reason, filed_at) VALUES (?, ?, ?, ?)",
        )
        .run(row.dispute_id, row.member_id, row.reason, filed_at);
    } catch (err) {
      if (isUniqueViolation(err)) throw new DuplicateFilingError(row.dispute_id);
      throw err;
    }
    const created = this.db
      .prepare("SELECT id, dispute_id, member_id, reason, filed_at FROM filings WHERE dispute_id = ?")
      .get(row.dispute_id) as Filing;
    return created;
  }

  insertSubAccount(row: { member_id: string; product: string; opened_at?: string }): SubAccount {
    const opened_at = row.opened_at ?? new Date().toISOString();
    this.db
      .prepare("INSERT INTO sub_accounts (member_id, product, opened_at) VALUES (?, ?, ?)")
      .run(row.member_id, row.product, opened_at);
    return this.db
      .prepare(
        "SELECT id, member_id, product, opened_at FROM sub_accounts WHERE id = last_insert_rowid()",
      )
      .get() as SubAccount;
  }

  reset(): void {
    this.db.exec("DELETE FROM filings; DELETE FROM sub_accounts;");
  }

  all(): Filing[] {
    return this.db
      .prepare("SELECT id, dispute_id, member_id, reason, filed_at FROM filings ORDER BY id")
      .all() as Filing[];
  }

  subAccounts(): SubAccount[] {
    return this.db
      .prepare("SELECT id, member_id, product, opened_at FROM sub_accounts ORDER BY id")
      .all() as SubAccount[];
  }

  countByDisputeId(disputeId: string): number {
    const row = this.db
      .prepare("SELECT count(*) AS count FROM filings WHERE dispute_id = ?")
      .get(disputeId) as { count: number };
    return row.count;
  }

  hasFiling(disputeId: string): boolean {
    return this.countByDisputeId(disputeId) > 0;
  }

  exec(sql: string): CountProof {
    const normalized = sql.trim().replace(/\s+/g, " ");
    const filing = normalized.match(/^select count\(\*\) from filings where dispute_id\s*=\s*'([^']+)'\s*;?$/i);
    if (filing?.[1]) {
      const count = this.countByDisputeId(filing[1]);
      return {
        assertion: `count of filings for ${filing[1]}`,
        note: "SQLite core ledger (node:sqlite, in-memory). This is the query a real core would run.",
        engine: "node:sqlite",
        sql: normalized,
        count,
      };
    }
    const share = normalized.match(
      /^select count\(\*\) from sub_accounts where member_id\s*=\s*'([^']+)'\s*;?$/i,
    );
    if (share?.[1]) {
      const row = this.db
        .prepare("SELECT count(*) AS count FROM sub_accounts WHERE member_id = ?")
        .get(share[1]) as { count: number };
      return {
        assertion: `count of sub-accounts for member ${share[1]}`,
        note: "SQLite core ledger (node:sqlite, in-memory). This is the query a real core would run.",
        engine: "node:sqlite",
        sql: normalized,
        count: row.count,
      };
    }
    throw new UnsupportedSqlError(
      `Unsupported SQL. This ledger accepts count queries on filings or sub_accounts. Got: ${sql}`,
    );
  }
}

function isUniqueViolation(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed/i.test(message);
}
