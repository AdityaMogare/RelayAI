import type { Capability } from "../src/core/types.ts";
import { readCapabilityFile } from "../src/artifact/store.ts";

/** On-disk goldens. Tests and verify load these; compile.ts does not duplicate them. */
export const LOOKUP_MEMBER_SAVINGS: Capability = readCapabilityFile("lookup-member-savings").capability;
export const OPEN_SUB_ACCOUNT: Capability = readCapabilityFile("open-sub-account").capability;
export const VERIFY_AND_FILE_DISPUTE: Capability = readCapabilityFile("verify-and-file-dispute").capability;

export const DISPUTE_OK = {
  memberId: "12345",
  merchant: "ACME POS",
  last4: "4412",
  reason: "Unauthorized",
};

export const WESTSIDE_LABELS = {
  Search: "Search Members",
  Disputes: "Card Disputes",
  Open: "Open Row",
  "File Dispute": "File Dispute Now",
  Continue: "Continue to Review",
  Confirm: "Confirm Filing",
  "Member Lookup": "Member Lookup Desk",
};
