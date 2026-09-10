export type MemberTier = "standard" | "gold";

export type Member = {
  id: string;
  name: string;
  status: "active" | "restricted";
  savings: string;
  checking: string;
  tier: MemberTier;
};

function member(
  id: string,
  name: string,
  savings: string,
  checking: string,
  extra: Partial<Member> = {},
): Member {
  return {
    id,
    name,
    status: extra.status ?? "active",
    savings,
    checking,
    tier: extra.tier ?? "standard",
  };
}

const CORE: Record<string, Member> = {
  "12345": member("12345", "Jane Doe", "$4,250.00", "$1,102.33", { tier: "gold" }),
  "67890": member("67890", "John Smith", "$890.50", "$2,010.00"),
  "55555": member("55555", "Restricted Member", "$0.00", "$0.00", { status: "restricted" }),
};

/** Last-name "Doe" search returns 14 rows including Jane. */
const DOE_GIVEN = [
  "Alan",
  "Beth",
  "Carl",
  "Dana",
  "Evan",
  "Faye",
  "Gus",
  "Hana",
  "Ivan",
  "Jade",
  "Kurt",
  "Lila",
  "Nate",
];

const DOES: Record<string, Member> = Object.fromEntries(
  DOE_GIVEN.map((given, i) => {
    const id = String(20001 + i);
    return [id, member(id, `${given} Doe`, `$${(100 + i).toFixed(2)}`, `$${(50 + i).toFixed(2)}`)];
  }),
);

export const MEMBERS: Record<string, Member> = { ...CORE, ...DOES };

export const PRODUCTS = ["Share Savings", "Money Market", "Certificate"];

export function productsForTier(tier: MemberTier): string[] {
  if (tier === "gold") return [...PRODUCTS];
  return ["Share Savings"];
}

export const DISPUTE_REASONS = ["Unauthorized", "Duplicate", "Incorrect amount"] as const;

export type DisputeStatus = "open" | "filed";

export type Dispute = {
  id: string;
  memberId: string;
  merchant: string;
  amount: string;
  posted: string;
  last4: string;
  status: DisputeStatus;
  caseNumber?: string;
};

const EXTRA_MERCHANTS = [
  ["ACME WHOLESALE", "$9.99", "2026-08-11"],
  ["RIVER MARKET", "$18.40", "2026-08-09"],
  ["CITY PARKING", "$4.00", "2026-08-08"],
  ["WESTSIDE CAFE", "$12.75", "2026-08-07"],
  ["TRANSIT TAP", "$2.50", "2026-08-06"],
  ["OFFICE SUPPLY", "$33.10", "2026-08-05"],
  ["HARBOR GRILL", "$54.22", "2026-08-04"],
  ["PAYROLL ADJ", "$1.00", "2026-08-03"],
  ["CLOUD STORAGE", "$6.99", "2026-08-01"],
];

const DISPUTE_SEED: Dispute[] = [
  {
    id: "DSP-1001",
    memberId: "12345",
    merchant: "ACME POS",
    amount: "$42.18",
    posted: "2026-08-14",
    last4: "4412",
    status: "open",
  },
  {
    id: "DSP-1002",
    memberId: "12345",
    merchant: "NORTHSIDE FUEL",
    amount: "$61.02",
    posted: "2026-07-02",
    last4: "4412",
    status: "filed",
    caseNumber: "CASE-66110",
  },
  {
    id: "DSP-1003",
    memberId: "12345",
    merchant: "MAINFRAME TIMEOUT",
    amount: "",
    posted: "2026-08-20",
    last4: "4412",
    status: "open",
  },
  ...EXTRA_MERCHANTS.map(([merchant, amount, posted], i) => ({
    id: `DSP-${1004 + i}`,
    memberId: "12345",
    merchant,
    amount,
    posted,
    last4: "4412",
    status: "open" as const,
  })),
];

export function cloneDisputes(): Dispute[] {
  return DISPUTE_SEED.map((row) => ({ ...row }));
}

/** Mutable default ledger for tests that do not start a console. */
export const DISPUTES: Dispute[] = cloneDisputes();

export const SEARCH_PAGE_SIZE = 10;
export const DISPUTE_PAGE_SIZE = 20;

export function lookupMember(id: string): Member | undefined {
  const q = id.trim();
  if (MEMBERS[q]) return MEMBERS[q];
  const lower = q.toLowerCase();
  return Object.values(MEMBERS).find((m) => m.name.toLowerCase() === lower);
}

export function searchMembersByLastName(lastName: string): Member[] {
  const needle = lastName.trim().toLowerCase();
  if (!needle) return [];
  return Object.values(MEMBERS)
    .filter((m) => m.name.toLowerCase().split(/\s+/).at(-1) === needle)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function paginate<T>(
  rows: T[],
  page: number,
  pageSize: number,
): { rows: T[]; page: number; pages: number; total: number } {
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const current = Math.min(Math.max(1, page), pages);
  const start = (current - 1) * pageSize;
  return { rows: rows.slice(start, start + pageSize), page: current, pages, total: rows.length };
}

export function listDisputes(memberId: string, rows: Dispute[] = DISPUTES): Dispute[] {
  return rows.filter((d) => d.memberId === memberId.trim());
}

export function lookupDispute(memberId: string, disputeId: string, rows: Dispute[] = DISPUTES): Dispute | undefined {
  const id = disputeId.trim().toUpperCase();
  return rows.find((d) => d.memberId === memberId.trim() && d.id.toUpperCase() === id);
}

export function findDispute(memberId: string, merchant: string, last4: string, rows: Dispute[] = DISPUTES): Dispute | undefined {
  const merch = merchant.trim().toLowerCase();
  const card = last4.trim();
  return rows.find(
    (d) => d.memberId === memberId.trim() && d.merchant.toLowerCase() === merch && d.last4 === card,
  );
}

export function markDisputeFiled(
  disputeId: string,
  caseNumber = "CASE-77201",
  rows: Dispute[] = DISPUTES,
): Dispute | undefined {
  const row = rows.find((d) => d.id.toUpperCase() === disputeId.trim().toUpperCase());
  if (!row) return undefined;
  row.status = "filed";
  row.caseNumber = caseNumber;
  return row;
}

export function resetDisputes(rows: Dispute[] = DISPUTES): void {
  const fresh = cloneDisputes();
  rows.splice(0, rows.length, ...fresh);
}

/** Exact id wins. Prefix / last-name matches feed the hostile two-hit search. */
export function searchMembers(query: string): Member[] {
  const q = query.trim();
  if (!q) return [];
  if (MEMBERS[q]) return [MEMBERS[q]!];
  const lower = q.toLowerCase();
  const byName = searchMembersByLastName(q);
  if (byName.length) return byName;
  return Object.values(MEMBERS).filter((m) => m.id.startsWith(q) || m.name.toLowerCase().includes(lower));
}
