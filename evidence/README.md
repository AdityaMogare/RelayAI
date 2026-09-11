# Evidence

Generated against the local Relay Credit Union console.

Through-line: `discover --id X` writes `capabilities/X.json`; `replay --capability capabilities/X.json` loads that same file. Both traces log `contentHash` (SHA-256 of the file bytes).

Open `index.html` for the catalog (status, code, duration, locator ranks, traces).

| Run | What it shows |
|---|---|
| `discovery-verify-and-file-dispute/` | **Impact path.** OpenAI `gpt-4o` discovers a teller scenario. Committed live run used a goal that named DSP-1001; the compiled golden now parameterizes merchant + last4 from the Jane Doe goal. Not `--scripted`. |
| `discovery-lookup-member-savings/` | Observe → **OpenAI `gpt-4o`** decide → act on a live Playwright session, then a compiled capability. Not `--scripted`. |
| `discovery-legacy-frameset/` | Scripted discovery against a real `<frameset>` (`/?legacy=1`). Observe/act walk every frame. |
| `discovery-assisted-escalation/` | Agent mashes Help; a human clicks Search; compiled artifact stamps `assistedBy`. |
| `discovery-assisted-attest/` | Jane Doe / ACME POS goal. Unfamiliar Supervisor Attestation interstitial → escalate → `teller01` clicks I attest on the live session → discovery resumes and compiles `assistedBy: "teller01"`. |
| `rediscover-verify-and-file-dispute/` | Product loop: replay v1 on westside-drift (rank-3 fallbacks, `needsRediscovery`) → scripted re-discover v2 → diff → replay green. |
| `equivalent-models/` | Same recording compiled with gpt-4o and claude provenance; step sequences are equivalent. |
| `replay-lookup-success/` | Deterministic replay of `capabilities/lookup-member-savings.json` with `memberId=12345`. No LLM. Same `contentHash` as the discovery stamp. Evidence money is `{ currency: "USD", minor: "[REDACTED]" }`. |
| `replay-lookup-not-found/` | Same capability file, `memberId=99999`, classified as `business_outcome` / `MEMBER_NOT_FOUND`. |
| `replay-tenant-westside/` | Same lookup artifact on CU West via `overlays/tenants/tenant-14.yaml` (Search → Find Member). Overlay keeps replay green. |
| `replay-tenant-westside-overlay/` | `--tenant westside`: Find Member, Card Claims, Branch Verification interstitial, field reorder. Same artifact, rank-1 green. |
| `replay-legacy-hostile/` | `?legacy=1`: frameset, presentation tables, generated ids, duplicate "Savings Balance". Ranked chain falls back; `needsRediscovery` fires. |
| `replay-verify-dispute-already-filed/` | Second Confirm of DSP-1001 after a real write. Core unique index + UI "Dispute already filed" — not the seeded DSP-1002 fixture. |
| `replay-drift-rediscovery/` | Rank-3 text locator on extract → confidence < 1 → `promoteHits` v2 → rank-1 green. |
| `replay-session-expired-reauth/` | `?expireMid=1` kills the session after Search; operator Sign In; replay skips the completed click and extracts. |
| `replay-ambiguous-row/` | Last name Doe returns 14 rows; Open is scoped to `:memberId` so Jane (12345) is selected. |
| `policy-blocked-admin-wire/` | Click **Wire Transfer**; Playwright route layer aborts `GET /admin/wire` (`policy.blocked` + `POLICY_VIOLATION`). |
| `stability-50/` | N=50 lookup soak: success rate, fallback rate, p50/p95 duration. |
| `cost-comparison.json` | Discovery vs replay cost/latency table. Tokens estimated when logs omit usage; durations are measured. |
| `escalate-open-sub-account/` | Risky Confirm: pause, auto-resume. `operatorKind: "scripted"`. Sub-account Confirm is a real POST that inserts into `sub_accounts`. |
| `escalate-verify-and-file-dispute/` | **HITL mechanism.** `humanCompletesRiskyStep` takes the lock and clicks Confirm on the live session. The record stamps `operatorKind: "scripted"` — timestamps in the hundreds of milliseconds are not a teller. `filings-proof.json` is a real `node:sqlite` count. |
| `escalate-verify-and-file-dispute-human/` | Same scripted waiter plus a stitched `handoff.gif` of before/after frames. A genuine headed click is `RELAY_HEADED=1 npm run escalate-demo -- --capability capabilities/verify-and-file-dispute.json` with the operator console at :3847; that path stamps `operatorKind: "human"`. |
| `replay-verify-dispute-success/` | Deterministic replay of `capabilities/verify-and-file-dispute.json` for ACME POS / 4412. No LLM. Confirm is approved via `--approve-risky`. |
| `replay-verify-dispute-not-found/` | Same capability file, `merchant=NO-SUCH` / `last4=0000`, classified as `business_outcome` / `DISPUTE_NOT_FOUND`. |
| `replay-recoverable-notice/` | `?notice=1`: dismiss the System Notice, then **retry the same step**. Status `success`. |
| `replay-hard-failure-locator/` | Locator miss on extract (`Savins Balance`). Status `failed` / `LOCATOR_MISS` with step id, expected, observed, screenshot. |
| `replay-needs-human-expired/` | `?expired=1`: session expired. Status `needs_human` / `SESSION_EXPIRED` — ops ticket, not a locator bug. |
| `replay-output-empty-amount/` | DSP-1003: dispute screen loads, amount cell empty (mainframe timeout). Checkpoints pass; typed money output fails `OUTPUT_INVALID`. |
| `replay-recoverable-exhausted/` | `?notice=always`: interstitial returns every time. After the retry cap, `needs_human` / `RECOVERABLE_EXHAUSTED`. |
| `replay-batch-reissue-40/` | 40 block+reissue invokes of `capabilities/block-and-reissue-card.json` (4412). Console reset between invokes. Uncapped — runtime.yaml 30/hr would stop this volume run. |
| `replay-batch-cap-exceeded/` | 31st invoke against runtime.yaml 30/hr → `failed` / `RATE_LIMIT`. Console reset before #31 so uniqueness cannot explain a zero write. |
| `replay-batch-idempotency/` | Second 4412 reissue; `card_actions` SQLite count = 1. |
| `escalate-batch-business-account/` | Card 3301: ControlPlane wired → `escalated` / `SUPERVISOR_REQUIRED`. Without a ControlPlane the same detector is `needs_human`. |

The reviewable capabilities live at `/capabilities/*.json`. `discover.artifact` / `replay.start` `contentHash` values are SHA-256 of that file. A fresh `discover --id X` stamps the hash on `discover.end` as well.
