# Evidence

Generated against the local Relay Credit Union console.

Through-line: `discover --id X` writes `capabilities/X.json`; `replay --capability capabilities/X.json` loads that same file. Both traces log `contentHash` (SHA-256 of the file bytes).

| Run | What it shows |
|---|---|
| `discovery-verify-and-file-dispute/` | **Impact path.** OpenAI `gpt-4o` discovers a teller scenario: lookup member 12345 → open DSP-1001 → verify amount → file Unauthorized → human resume on Confirm. Not `--scripted`. `npm run evidence` leaves live discovery folders alone and stamps the capability file hash. |
| `discovery-lookup-member-savings/` | Observe → **OpenAI `gpt-4o`** decide → act on a live Playwright session, then a compiled capability. Not `--scripted`. |
| `replay-lookup-success/` | Deterministic replay of `capabilities/lookup-member-savings.json` with `memberId=12345`. No LLM. Same `contentHash` as the discovery stamp. |
| `replay-lookup-not-found/` | Same capability file, `memberId=99999`, classified as `business_outcome` / `MEMBER_NOT_FOUND`. |
| `escalate-open-sub-account/` | Replay of a risky Confirm: pause the same session, record before/after url+title+screenshot+a11y diff, auto-resume (not a fabricated operator click), then reconcile skip-vs-execute. |
| `escalate-verify-and-file-dispute/` | **HITL bar.** Operator `teller01` takes the live session, clicks Confirm, hands back `completed_by_human`. Automation re-observes, skips the click, finishes. `filings-proof.json` is `SELECT count(*) FROM filings WHERE dispute_id='DSP-1001'` = 1. |
| `replay-verify-dispute-success/` | Deterministic replay of `capabilities/verify-and-file-dispute.json` for `DSP-1001`. No LLM. Confirm is approved via `--approve-risky`. |
| `replay-verify-dispute-not-found/` | Same capability file, `disputeId=DSP-9999`, classified as `business_outcome` / `DISPUTE_NOT_FOUND`. |
| `replay-recoverable-notice/` | `?notice=1`: dismiss the System Notice, then **retry the same step**. Status `success`. |
| `replay-hard-failure-locator/` | Locator miss on extract (`Savins Balance`). Status `failed` / `LOCATOR_MISS` with step id, expected, observed, screenshot. |
| `replay-needs-human-expired/` | `?expired=1`: session expired. Status `needs_human` / `SESSION_EXPIRED` — ops ticket, not a locator bug. |
| `replay-output-empty-amount/` | DSP-1003: dispute screen loads, amount cell empty (mainframe timeout). Checkpoints pass; typed money output fails `OUTPUT_INVALID`. |
| `replay-recoverable-exhausted/` | `?notice=always`: interstitial returns every time. After the retry cap, `needs_human` / `RECOVERABLE_EXHAUSTED`. |

The reviewable capabilities live at `/capabilities/*.json`. `discover.artifact` / `replay.start` `contentHash` values are SHA-256 of that file. A fresh `discover --id X` stamps the hash on `discover.end` as well.
