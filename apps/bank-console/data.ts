export type Member = {
  id: string;
  name: string;
  status: "active" | "restricted";
  savings: string;
  checking: string;
};

export const MEMBERS: Record<string, Member> = {
  "12345": {
    id: "12345",
    name: "Jane Doe",
    status: "active",
    savings: "$4,250.00",
    checking: "$1,102.33",
  },
  "67890": {
    id: "67890",
    name: "John Smith",
    status: "active",
    savings: "$890.50",
    checking: "$2,010.00",
  },
  "55555": {
    id: "55555",
    name: "Restricted Member",
    status: "restricted",
    savings: "$0.00",
    checking: "$0.00",
  },
};

export const PRODUCTS = ["Share Savings", "Money Market", "Certificate"];

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

export const DISPUTES: Dispute[] = [
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
];

export function lookupMember(id: string): Member | undefined {
  return MEMBERS[id.trim()];
}

export function listDisputes(memberId: string): Dispute[] {
  return DISPUTES.filter((d) => d.memberId === memberId.trim());
}

export function lookupDispute(memberId: string, disputeId: string): Dispute | undefined {
  const id = disputeId.trim().toUpperCase();
  return DISPUTES.find((d) => d.memberId === memberId.trim() && d.id.toUpperCase() === id);
}
