import type { AgentDecision } from "../core/llm.ts";

export const JANE_DOE_DISPUTE_GOAL =
  "Jane Doe called about an unauthorized charge from ACME POS on her card ending 4412. Find that transaction, verify the amount, and file it as Unauthorized.";

export function scriptedLookup(): AgentDecision[] {
  return [
    { tool: "type", role: "textbox", name: "Member ID", text: "12345", reason: "Enter the member number from the goal." },
    { tool: "click", role: "button", name: "Search", reason: "Submit the lookup." },

    {
      tool: "extract",
      role: "cell",
      name: "Savings Balance",
      outputName: "savingsBalance",
      reason: "Read the savings balance.",
    },
    {
      tool: "finish",
      reason: "Savings balance is visible.",
      outputs: { savingsBalance: "$4,250.00" },
    },
  ];
}

/** Type the member id, mash Help until discovery is stuck, then extract after a human Search. */
export function scriptedLookupStuckHelp(): AgentDecision[] {
  return [
    { tool: "type", role: "textbox", name: "Member ID", text: "12345", reason: "Enter the member number from the goal." },
    { tool: "click", role: "button", name: "Help", reason: "Unsure which control submits." },
    { tool: "click", role: "button", name: "Help", reason: "Help did not change the screen." },
    { tool: "escalate", reason: "Help did not change the screen; need a human to submit Search." },
    {
      tool: "extract",
      role: "cell",
      name: "Savings Balance",
      outputName: "savingsBalance",
      reason: "Read the savings balance after the operator searched.",
    },
    {
      tool: "finish",
      reason: "Savings balance is visible after human assistance.",
      outputs: { savingsBalance: "$4,250.00" },
    },
  ];
}

/** Example A: goal has no DSP- id. Type the name, click the ACME POS row. */
export function scriptedFileByMerchant(): AgentDecision[] {
  return [
    { tool: "type", role: "textbox", name: "Member ID", text: "Jane Doe", reason: "Goal names the member, not an ID." },
    { tool: "click", role: "button", name: "Search", reason: "Find Jane Doe." },
    { tool: "click", role: "link", name: "Disputes", reason: "Open the dispute queue." },
    { tool: "click", role: "link", name: "Open", reason: "Open the ACME POS row for card 4412." },
    {
      tool: "extract",
      role: "cell",
      name: "Transaction Amount",
      outputName: "transactionAmount",
      reason: "Verify the amount.",
    },
    { tool: "click", role: "link", name: "File Dispute", reason: "Start filing." },
    { tool: "select", role: "combobox", name: "Reason", text: "Unauthorized", reason: "Reason from the call." },
    { tool: "click", role: "button", name: "Continue", reason: "Review the filing." },
    { tool: "click", role: "button", name: "Confirm", reason: "File the dispute." },
    {
      tool: "extract",
      role: "status",
      name: "Confirmation",
      outputName: "confirmation",
      reason: "Read the confirmation.",
    },
    { tool: "finish", reason: "Dispute filed.", outputs: { confirmation: "Dispute filed" } },
  ];
}

/** Example B: stuck on supervisor attestation, escalate, then continue after the human. */
export function scriptedAssistedDiscovery(): AgentDecision[] {
  return [
    { tool: "type", role: "textbox", name: "Member ID", text: "Jane Doe", reason: "Goal names the member." },
    { tool: "click", role: "button", name: "Search", reason: "Find Jane Doe." },
    { tool: "click", role: "link", name: "Disputes", reason: "Open the queue." },
    { tool: "escalate", reason: "Unfamiliar Supervisor Attestation interstitial." },
    { tool: "click", role: "link", name: "Open", reason: "Open the ACME POS row." },
    {
      tool: "extract",
      role: "cell",
      name: "Transaction Amount",
      outputName: "transactionAmount",
      reason: "Verify the amount.",
    },
    { tool: "click", role: "link", name: "File Dispute", reason: "Start filing." },
    { tool: "select", role: "combobox", name: "Reason", text: "Unauthorized", reason: "Reason from the call." },
    { tool: "click", role: "button", name: "Continue", reason: "Review." },
    { tool: "click", role: "button", name: "Confirm", reason: "File." },
    {
      tool: "extract",
      role: "status",
      name: "Confirmation",
      outputName: "confirmation",
      reason: "Read confirmation.",
    },
    { tool: "finish", reason: "Filed with human assistance on the attestation.", outputs: { confirmation: "Dispute filed" } },
  ];
}

export const BLOCK_AND_REISSUE_GOAL =
  "Block and reissue the debit card ending 4412 for member 12345 in CAMS.";

/** CAMS: look up the member, open the card by last 4, block, then reissue. */
export function scriptedBlockAndReissue(): AgentDecision[] {
  return [
    { tool: "type", role: "textbox", name: "Member ID", text: "12345", reason: "Enter the member number from the goal." },
    { tool: "click", role: "button", name: "Search", reason: "Submit the lookup." },
    { tool: "click", role: "link", name: "CAMS", reason: "Open the card batch." },
    { tool: "type", role: "textbox", name: "Card last 4", text: "4412", reason: "Last 4 from the goal." },
    { tool: "click", role: "button", name: "Open by last 4", reason: "Open that card." },
    { tool: "click", role: "link", name: "Block Card", reason: "Start the block." },
    { tool: "click", role: "button", name: "Confirm", reason: "Confirm the block." },
    { tool: "click", role: "button", name: "Confirm", reason: "Confirm the reissue." },
    {
      tool: "extract",
      role: "status",
      name: "Confirmation",
      outputName: "confirmation",
      reason: "Read the confirmation.",
    },
    { tool: "finish", reason: "Card blocked and reissued.", outputs: { confirmation: "Card reissued" } },
  ];
}

/** Westside re-discovery: same flow, longer accessible names. */
export function scriptedWestsideFileByMerchant(): AgentDecision[] {
  return [
    { tool: "type", role: "textbox", name: "Member ID", text: "Jane Doe", reason: "Goal names the member." },
    { tool: "click", role: "button", name: "Search Members", reason: "Westside search." },
    { tool: "click", role: "link", name: "Card Disputes", reason: "Westside disputes." },
    { tool: "click", role: "link", name: "Open Row", reason: "Open the ACME POS row." },
    {
      tool: "extract",
      role: "cell",
      name: "Transaction Amount",
      outputName: "transactionAmount",
      reason: "Verify the amount.",
    },
    { tool: "click", role: "link", name: "File Dispute Now", reason: "Start filing." },
    { tool: "select", role: "combobox", name: "Reason", text: "Unauthorized", reason: "Reason." },
    { tool: "click", role: "button", name: "Continue to Review", reason: "Review." },
    { tool: "click", role: "button", name: "Confirm Filing", reason: "File." },
    {
      tool: "extract",
      role: "status",
      name: "Confirmation",
      outputName: "confirmation",
      reason: "Read confirmation.",
    },
    { tool: "finish", reason: "Dispute filed on westside.", outputs: { confirmation: "Dispute filed" } },
  ];
}
