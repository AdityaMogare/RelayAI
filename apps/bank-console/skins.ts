export type ConsoleSkinId = "relay" | "cu-west" | "westside";

export type ConsoleSkin = {
  id: ConsoleSkinId;
  tenantId: string;
  titlePrefix: string;
  banner: string;
  institution: string;
  operator: string;
  bannerBg: string;
  subBg: string;
  /** Westside: Checking before Savings; search control before the ID field. */
  fieldOrder: "recorded" | "westside";
  extraInterstitial?: {
    title: string;
    body: string;
    dismiss: string;
  };
  labels: {
    memberLookup: string;
    memberId: string;
    search: string;
    confirm: string;
    savingsBalance: string;
    disputes: string;
    open: string;
    fileDispute: string;
    continue: string;
    cams: string;
    blockCard: string;
    reissueCard: string;
  };
};

/** Tenant 9 — the skin the artifacts were recorded against. */
export const RELAY_SKIN: ConsoleSkin = {
  id: "relay",
  tenantId: "tenant-9",
  titlePrefix: "Relay Credit Union",
  banner: "RELAY CREDIT UNION — Member Servicing",
  institution: "Demo CU",
  operator: "teller01",
  bannerBg: "#1f4a7a",
  subBg: "#8a7d4e",
  fieldOrder: "recorded",
  labels: {
    memberLookup: "Member Lookup",
    memberId: "Member ID",
    search: "Search",
    confirm: "Confirm",
    savingsBalance: "Savings Balance",
    disputes: "Disputes",
    open: "Open",
    fileDispute: "File Dispute",
    continue: "Continue",
    cams: "CAMS",
    blockCard: "Block Card",
    reissueCard: "Reissue Card",
  },
};

/** Tenant 14 — same vendor product, 4.2 copy. Visibly different chrome + labels. */
export const CU_WEST_SKIN: ConsoleSkin = {
  id: "cu-west",
  tenantId: "tenant-14",
  titlePrefix: "CU West",
  banner: "CU WEST — Member Servicing",
  institution: "CU West",
  operator: "teller01",
  bannerBg: "#6b3a1f",
  subBg: "#a67c3d",
  fieldOrder: "recorded",
  labels: {
    memberLookup: "Find a Member",
    memberId: "Member ID",
    search: "Find Member",
    confirm: "Submit Request",
    savingsBalance: "Savings Balance",
    disputes: "Disputes",
    open: "Open",
    fileDispute: "File Dispute",
    continue: "Continue",
    cams: "Card Batch",
    blockCard: "Block Plastic",
    reissueCard: "Reissue Plastic",
  },
};

/**
 * Westside CU — §3.7 overlay demo: Find Member, Card Claims, extra interstitial,
 * two fields reordered. Overlay remaps copy so the recorded artifact stays green.
 */
export const WESTSIDE_SKIN: ConsoleSkin = {
  ...CU_WEST_SKIN,
  id: "westside",
  tenantId: "westside",
  titlePrefix: "Westside CU",
  banner: "WESTSIDE CU — Member Servicing",
  institution: "Westside CU",
  bannerBg: "#1a5c4a",
  subBg: "#4a7a3d",
  fieldOrder: "westside",
  extraInterstitial: {
    title: "Branch Verification",
    body: "Westside requires tellers to acknowledge the branch network before member lookup.",
    dismiss: "Continue",
  },
  labels: {
    ...CU_WEST_SKIN.labels,
    disputes: "Card Claims",
    cams: "Plastic Queue",
    blockCard: "Block Plastic",
    reissueCard: "Reissue Plastic",
  },
};

/**
 * Longer accessible names with no overlay remaps. Rank-1 misses; rank-3 text
 * still hits. Used by `npm run rediscover`.
 */
export const WESTSIDE_DRIFT_SKIN: ConsoleSkin = {
  id: "westside",
  tenantId: "westside-drift",
  titlePrefix: "Westside CU",
  banner: "WESTSIDE CU — Member Servicing",
  institution: "Westside CU",
  operator: "teller01",
  bannerBg: "#1a5c4a",
  subBg: "#4a7a3d",
  fieldOrder: "recorded",
  labels: {
    memberLookup: "Member Lookup Desk",
    memberId: "Member ID",
    search: "Search Members",
    confirm: "Confirm Filing",
    savingsBalance: "Savings Balance",
    disputes: "Card Disputes",
    open: "Open Row",
    fileDispute: "File Dispute Now",
    continue: "Continue to Review",
    cams: "Plastic Queue Desk",
    blockCard: "Block Plastic Now",
    reissueCard: "Reissue Plastic Now",
  },
};

export function skinById(id: string | undefined): ConsoleSkin {
  if (id === "cu-west" || id === "tenant-14") return CU_WEST_SKIN;
  if (id === "westside-drift") return WESTSIDE_DRIFT_SKIN;
  if (id === "westside") return WESTSIDE_SKIN;
  return RELAY_SKIN;
}
