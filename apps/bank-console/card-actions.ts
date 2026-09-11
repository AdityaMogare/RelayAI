import { DatabaseSync } from "node:sqlite";

export type CardAction = {
  id: number;
  member_id: string;
  last4: string;
  case_number: string;
  acted_at: string;
};

export type CardCountProof = {
  assertion: string;
  note: string;
  engine: "node:sqlite";
  sql: string;
  count: number;
};

export class DuplicateCardActionError extends Error {
  readonly memberId: string;
  readonly last4: string;

  constructor(memberId: string, last4: string) {
    super(`Card ${last4} for member ${memberId} is already reissued.`);
    this.name = "DuplicateCardActionError";
    this.memberId = memberId;
    this.last4 = last4;
  }
}

export class UnsupportedCardSqlError extends Error {
  constructor(sql: string) {
    super(`Unsupported SQL. This ledger accepts count queries on card_actions. Got: ${sql}`);
    this.name = "UnsupportedCardSqlError";
  }
}

/**
 * SQLite core ledger (node:sqlite, in-memory). Unique on (member_id, last4) so a
 * second reissue is a core rejection, not only an automation-ledger conflict.
 */
export class CardActionsStore {
  private readonly db: DatabaseSync;

  constructor() {
    this.db = new DatabaseSync(":memory:");
    this.db.exec(`
      CREATE TABLE card_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id TEXT NOT NULL,
        last4 TEXT NOT NULL,
        case_number TEXT NOT NULL,
        acted_at TEXT NOT NULL,
        UNIQUE (member_id, last4)
      );
    `);
  }

  nextCaseNumber(): string {
    const row = this.db.prepare("SELECT coalesce(max(id), 0) AS id FROM card_actions").get() as { id: number };
    return `CASE-${88000 + row.id + 1}`;
  }

  insert(row: { member_id: string; last4: string; case_number?: string; at?: string }): CardAction {
    const acted_at = row.at ?? new Date().toISOString();
    const case_number = row.case_number ?? this.nextCaseNumber();
    try {
      this.db
        .prepare(
          "INSERT INTO card_actions (member_id, last4, case_number, acted_at) VALUES (?, ?, ?, ?)",
        )
        .run(row.member_id, row.last4, case_number, acted_at);
    } catch (err) {
      if (isUniqueViolation(err)) throw new DuplicateCardActionError(row.member_id, row.last4);
      throw err;
    }
    return this.db
      .prepare(
        "SELECT id, member_id, last4, case_number, acted_at FROM card_actions WHERE member_id = ? AND last4 = ?",
      )
      .get(row.member_id, row.last4) as CardAction;
  }

  reset(): void {
    this.db.exec("DELETE FROM card_actions;");
  }

  all(): CardAction[] {
    return this.db
      .prepare("SELECT id, member_id, last4, case_number, acted_at FROM card_actions ORDER BY id")
      .all() as CardAction[];
  }

  lookup(memberId: string, last4: string): CardAction | undefined {
    return this.db
      .prepare(
        "SELECT id, member_id, last4, case_number, acted_at FROM card_actions WHERE member_id = ? AND last4 = ?",
      )
      .get(memberId, last4) as CardAction | undefined;
  }

  countByCard(memberId: string, last4: string): number {
    const row = this.db
      .prepare("SELECT count(*) AS count FROM card_actions WHERE member_id = ? AND last4 = ?")
      .get(memberId, last4) as { count: number };
    return row.count;
  }

  has(memberId: string, last4: string): boolean {
    return this.countByCard(memberId, last4) > 0;
  }

  exec(sql: string): CardCountProof {
    const normalized = sql.trim().replace(/\s+/g, " ");
    const match = normalized.match(
      /^select count\(\*\) from card_actions where member_id\s*=\s*'([^']+)'\s+and last4\s*=\s*'([^']+)'\s*;?$/i,
    );
    if (match?.[1] && match[2]) {
      const count = this.countByCard(match[1], match[2]);
      return {
        assertion: `count of card actions for ${match[1]} / ${match[2]}`,
        note: "SQLite core ledger (node:sqlite, in-memory). This is the query a real core would run.",
        engine: "node:sqlite",
        sql: normalized,
        count,
      };
    }
    throw new UnsupportedCardSqlError(sql);
  }
}

function isUniqueViolation(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed/i.test(message);
}
