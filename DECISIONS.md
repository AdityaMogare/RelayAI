# Decision log

Living record of choices for RelayAI. **Append new entries at the bottom** (next unused `D-xxx`). Do not rewrite history — if a decision changes, add a new entry that supersedes the old one and mark the old status `superseded`.

Status: `accepted` | `superseded` | `proposed`

---

## D-001 — Language and runtime

- **Date:** 2026-09-09
- **Status:** accepted
- **Context:** The brief leaves language open. Artifact/result contracts are a graded focal point.
- **Decision:** TypeScript on Node 20+, ESM, `tsx` for the CLI.
- **Why:** Zod + Playwright + a typed JSON capability live in one language. Reviewers can read the schema as both types and runtime checks.
- **Rejected:** Python (weaker shared typing with the artifact), a multi-service split.

## D-002 — Target application

- **Date:** 2026-09-09
- **Status:** accepted
- **Context:** No real bank system. Need a proxy that exercises search → detail and runtime exceptions.
- **Decision:** Local “Relay Credit Union” console (`apps/bank-console/`) — nested tables, iframe ticker, no test IDs.
- **Why:** We control “member not found,” permission denied, validation, system notice, session expiry, and slowness. A public cart site cannot show the business-outcome vs failure distinction the brief calls the common design mistake.
- **Rejected:** Sauce Demo / public e-commerce (ToS + no first-class not-found outcome).

## D-003 — Seeded members and injectable states

- **Date:** 2026-09-09
- **Status:** accepted
- **Decision:**
  - `12345` Jane Doe — happy path (`$4,250.00` savings)
  - `67890` John Smith
  - `55555` restricted → `PERMISSION_DENIED`
  - `99999` → `MEMBER_NOT_FOUND`
  - `?notice=1` recoverable dialog, `?expired=1` hard failure, `?slow=1` delay
- **Why:** Replay taxonomy needs deterministic fixtures, not hoping a public site errors.

## D-004 — Computer-use surface

- **Date:** 2026-09-09
- **Status:** accepted
- **Decision:** Playwright + accessibility tree. Locators: role + **exact** accessible name → label → text → CSS last. Resolve across all frames.
- **Why:** Legacy cores have no test IDs. Role+name is the same idea as OS a11y, so a desktop adapter later does not change the artifact. Exact match is required because a nested-table `cell` named “Savings Balance” otherwise matches the outer wrapper and returns the whole record.
- **Rejected:** CSS/XPath as primary, screenshot+coordinates as primary (brittle; fine as a future fallback).

## D-005 — Process topology

- **Date:** 2026-09-09
- **Status:** accepted
- **Decision:** Single process + CLI (`discover`, `replay`, `escalate-demo`, `capabilities`). No queues, workers, or DB.
- **Why:** The brief penalizes premature scale. The interesting seams are Surface / Artifact / Replay / Policy / Control, not process boundaries.
- **Trade-off:** No concurrent writers on artifact files. Irrelevant at this size.

## D-006 — Five ports, adapters at the CLI

- **Date:** 2026-09-09
- **Status:** accepted
- **Decision:** Core depends on interfaces only: `Surface`, `LlmClient`, `ArtifactStore`, `PolicyGuard`, `ControlPlane` / `ResumeWaiter`. Playwright, Anthropic/OpenAI, and the operator page are adapters.
- **Why:** Discovery and replay share Surface + Policy. Adding a desktop surface or another LLM is a new file, not a rearchitecture. Tests use `MockSurface` + `ScriptedLlm` + `MemoryArtifactStore`.

## D-007 — LLM only on discovery

- **Date:** 2026-09-09
- **Status:** accepted
- **Decision:** Anthropic first (`claude-sonnet-4-20250514`), OpenAI-compatible fallback via `RELAY_LLM_PROVIDER`. Replay never calls a model. `--scripted` exists for offline / CI.
- **Why:** “The model discovers. The artifact is the capability. Deterministic replay is production.” An LLM recovery path on replay would blur that line (see D-024).
- **Note:** Committed discovery evidence used `--scripted` against a live browser because no API key was present. Re-run with `ANTHROPIC_API_KEY` before submission.

## D-008 — Artifact is a function, not a transcript

- **Date:** 2026-09-09
- **Status:** accepted
- **Decision:** Versioned JSON (`schemaVersion: "1.0"`) with `parameters[]`, `outputs[]`, ranked locators, `exceptionalStates[]`, and a success checkpoint. Stored under `capabilities/`.
- **Why:** A calling agent (and a human reviewer) needs a contract. Dumping the model transcript fails reviewability and parameterization.

## D-009 — Bind capabilities to vendor, not hostname

- **Date:** 2026-09-09
- **Status:** accepted
- **Decision:** `app.vendorId` + `surfaceKind` (`relay-core` / `legacy-web`). Replay rewrites the entry host with `--base-url`.
- **Why:** Hundreds of tenants run the same vendor product. Tests also need ephemeral ports. Tenant overlays (copy variants, extra interstitials) would specialize detectors later — not a new capability per CU.

## D-010 — Parameterize discovery literals

- **Date:** 2026-09-09
- **Status:** accepted
- **Decision:** Values from the goal that were typed into a field become `parameters.*` (`12345` → `memberId`). Artifacts store the reference, not the literal. Names matching password/token/ssn are marked `sensitive`.
- **Why:** Regulated data must not persist in a reviewable artifact. Replay supplies fresh inputs per invocation.

## D-011 — Exceptional states live on the artifact

- **Date:** 2026-09-09
- **Status:** accepted
- **Decision:** Vendor-level detectors on every lookup/open capability: not-found, denied, validation, system notice (recoverable + dismiss), session expiry (hard failure).
- **Why:** Replay must classify screens it has never “seen” on this invocation. This is also the multi-tenant hook — overlays add detectors, they do not re-record the flow.

## D-012 — Result contract (four statuses)

- **Date:** 2026-09-09
- **Status:** superseded
- **Decision:** `success` | `business_outcome` | `escalated` | `failed`. Failed includes `stepId`, `expected`, `observed`, screenshot path.
- **Why:** “No such member” is a legitimate caller result. Conflating it with a crash is the failure mode the brief names.
- **Superseded by:** D-034

## D-013 — Check exceptions before acting; recover retries the same step

- **Date:** 2026-09-09
- **Status:** accepted
- **Decision:** After every observation, run detectors before the step. Recoverable → dismiss/wait, then **retry this step** (cap 3). Do not `continue` to the next step.
- **Why:** An early loop skipped work after a System Notice. Retry-same-step is the only safe recover.

## D-014 — Wait strategy

- **Date:** 2026-09-09
- **Status:** accepted
- **Decision:** `domcontentloaded` + ~150ms settle. Default Playwright action timeout 8s. Not `networkidle`.
- **Why:** These apps are slow in the “server think” sense, not SPA hydration. Checkpoints on the a11y tree are the real ready-signal.

## D-015 — Locator exact-name matching

- **Date:** 2026-09-09
- **Status:** accepted
- **Context:** First live extract of “Savings Balance” returned the entire member table (outer `td` accessible name contains the inner text).
- **Decision:** `getByRole(..., { name, exact: true })`. CSS `[aria-label=…]` remains a last-resort fallback on the extract step.
- **Why:** Substring name match is unsafe on nested tables. Exact name is a robustness rule, not a Playwright default we stumbled into.

## D-016 — `about:blank` is not an off-policy host

- **Date:** 2026-09-09
- **Status:** accepted
- **Context:** First navigate failed policy because observe ran on `about:blank` (empty hostname).
- **Decision:** Exempt `about:`, `data:`, `blob:` from the current-origin allowlist check. Still enforce the **target** URL of `navigate`.
- **Why:** The guard is “do not leave the console,” not “the browser must already be on the console before the first goto.”

## D-017 — Safety: host allowlist + name-based risk

- **Date:** 2026-09-09
- **Status:** accepted
- **Decision:** YAML allowlist (`localhost` / `127.0.0.1`; listed action types). Risk is from control **names** (`Confirm`, `Delete`, `Approve`, `Open Sub-Account`), not from `click` itself. Unattended replay blocks risky steps unless `--approve-risky` or a human resume.
- **Why:** Irreversible bank actions must not run dark. Lookup clicks stay cheap. Host-level (not route-level) is enough for one local console; noted as a limit.

## D-018 — Redaction on every evidence write

- **Date:** 2026-09-09
- **Status:** accepted
- **Decision:** Regex pass for SSN, account-like tokens, bearer, long digit runs, and keys named password/token/ssn. Applied in `EvidenceStore` before JSONL/JSON hits disk.
- **Why:** Logs are the leak surface. Limits: novel identifier formats will slip through; this is not DLP.

## D-019 — Control lock on the same live session

- **Date:** 2026-09-09
- **Status:** accepted
- **Decision:** Session owner is `automation` | `human`. `act` refuses when the human holds the lock. Escalation writes `intervention.json` + screenshot, `surface.pause()`, then a `ResumeWaiter`. The human uses the headed Playwright window; a local page (`:3847`) only transfers the lock (Resume / Abort).
- **Why:** The brief wants a real handoff mechanism, not a co-browse product. Abort leaves control with the human and returns `escalated`.

## D-020 — Risky step: escalate once, then treat as approved

- **Date:** 2026-09-09
- **Status:** superseded
- **Decision:** After a human resume on a risky step, execute that step without re-escalating. `RELAY_AUTO_RESUME_MS` / `immediateResume` exist for evidence and tests.
- **Why:** Re-checking `!approveRisky` after resume would loop forever. Resume *is* the approval.
- **Superseded by:** D-033

## D-021 — Only Confirm is risky on open-sub-account

- **Date:** 2026-09-09
- **Status:** accepted
- **Decision:** “Open Sub-Account” (navigate to a form) is `safe`. “Confirm” is `risky`.
- **Why:** Opening a form is reversible. Confirming is not. Escalation should fire at the irreversible click, not at the start of the flow.

## D-022 — Stuck detection

- **Date:** 2026-09-09
- **Status:** accepted
- **Decision:** Escalate on max discovery steps, three identical observations, policy violation, risky step without approval, or the model’s `escalate` tool.
- **Why:** Thin but real. Covers discovery dead-ends and production policy blocks without a separate “stuck classifier.”

## D-023 — Observability: JSONL + screenshot, not Langfuse

- **Date:** 2026-09-09
- **Status:** accepted
- **Decision:** Structured `log.jsonl` per run, screenshot on failure/escalation. Replay does not go through an LLM tracer.
- **Why:** Hosted tracing is optional and would send redacted-but-still-sensitive bank-shaped text to a third party. Replay has no model — wrapping it in LLM observability would misrepresent the path. Companion `Implementation.md` mentioned Langfuse/CALL-E; those were not built.

## D-024 — Cuts (intentionally not built)

- **Date:** 2026-09-09
- **Status:** accepted
- **Decision:** No desktop adapter, no multi-tenant runtime, no co-browse, no queues, no assisted LLM fallback on replay failure, no second live-model capability. Thin stretch: `capabilities list` / `invoke`.
- **Why:** Depth on schema, replay taxonomy, and handoff. Assisted fallback would put the model back in the production path.

## D-025 — Evidence layout and honesty

- **Date:** 2026-09-09
- **Status:** superseded
- **Decision:** `/evidence` holds discovery (scripted, live browser), happy replay, `99999` business outcome, and escalate-on-confirm with screenshot. Discovery is labeled scripted in `evidence/README.md`.
- **Why:** The brief requires evidence of a real loop. Faking a model transcript is worse than labeling a scripted decide step on a real surface.
- **Superseded by:** D-029

## D-026 — Goldens: lookup compiled, open-sub-account hand-authored

- **Date:** 2026-09-09
- **Status:** accepted
- **Decision:** `capabilities/lookup-member-savings.json` is the primary demo artifact. `open-sub-account.json` is hand-authored so the risky-path demo does not depend on a model key.
- **Why:** Two capabilities show the schema is not a one-flow special case. Only lookup needed a discovery compiler path for the write-up.

## D-027 — Dialog observe must not wait 30s

- **Date:** 2026-09-09
- **Status:** accepted
- **Context:** `getByRole("dialog").first().getAttribute(...)` waited the default timeout when no dialog existed; integration tests hung.
- **Decision:** `count()` first; only then read the name. Set context default timeout to 8s.
- **Why:** Observe runs every step. Waiting for a dialog that is not there is a hang, not a check.

---

## D-028 — Second capability is verify-and-file-dispute

- **Date:** 2026-09-09
- **Status:** superseded
- **Context:** Implementation.md M1 leftover (dispute list + detail) and M9 (`verify_and_file_dispute`). CALL-E (M7) stays cut.
- **Decision:** Add dispute queue / detail / file / confirm screens to the local console. Hand-author `capabilities/verify-and-file-dispute.json`. Parameterize `memberId`, `disputeId`, and `reason` via typed fields (not a click on a table row). Confirm remains the only risky step; unattended replay uses `--approve-risky` instead of a phone channel.
- **Why:** Two capabilities still need to show the schema is not a one-flow special case. Typing the dispute ID keeps `inputFrom` working without changing the locator model. Seeded `DSP-9999` / `DSP-1002` give `DISPUTE_NOT_FOUND` and `DISPUTE_ALREADY_FILED` without a live model.
- **Rejected:** Wiring CALL-E as the filing gate (D-023 / D-024). Clicking a dispute-id link as the primary step (not parameterizable with today's `inputFrom`).
- **Superseded by:** D-030

---

## D-029 — Live OpenAI discovery evidence

- **Date:** 2026-09-10
- **Status:** accepted
- **Context:** Section 4 requires a genuine LLM-driven discovery in `/evidence/`. D-025 committed a labeled `--scripted` run because no key was present. `OPENAI_API_KEY` is now on this machine; Anthropic is not.
- **Decision:** Re-run `lookup-member-savings` discovery with OpenAI `gpt-4o`. Stamp `{ provider, model, scripted }` on `discover.start` and each `discover.decide`. Replace `evidence/discovery-lookup-member-savings/`. Keep `npm run evidence` on replay + escalation only so no-key clones do not overwrite the live transcript. Extract prefers the adjacent value cell when the locator hits a table rowheader (same accessible name on `<th>` and `<td>`).
- **Why:** The required thread is now honest: model discovers, artifact is the capability, replay has no LLM.
- **Supersedes:** D-025 (and the D-007 note that committed evidence was scripted)

---

## D-030 — Live discovery of verify-and-file-dispute

- **Date:** 2026-09-10
- **Status:** accepted
- **Context:** Lookup discovery is three steps and reads as a toy. Graders need a genuine LLM run that looks like servicing work. P1.2 allows one extra live artifact; a fourth CU workflow is still out.
- **Decision:** Live-discover `verify-and-file-dispute` with OpenAI `gpt-4o` against a teller goal (unauthorized ACME POS on member 12345 / DSP-1001). Queue IDs are typed, not clicked. Confirm remains risky and pauses the same session (`risky.png` + `human` resume). Compiler lifts quoted select values, attaches dispute exceptions, and ignores extract-of-a-button. `open-sub-account` stays hand-authored.
- **Why:** One extra live compile proves the schema is not a special case of lookup, and the transcript shows multi-step work plus irreversible-step handoff.
- **Supersedes:** D-024’s “no second live-model capability”; D-028’s “hand-author verify-and-file-dispute”

---

## D-031 — Through-line is the file on disk

- **Date:** 2026-09-10
- **Status:** accepted
- **Context:** `discover --id X` wrote `capabilities/X.json`, but `replay` accepted a bare id and `loadCapability` silently returned a hardcoded CONST on any miss. `capabilities list` also `store.save(CONST)` three times, stomping live compiles. Evidence traces did not prove the same bytes were replayed.
- **Decision:** Replay loads `capabilities/X.json` (path form in README and `/evidence`). `loadCapability` fails loudly if the file is missing. The capabilities catalog no longer rewrites disk. Both `discover.end` and `replay.start` log SHA-256 of the file bytes (`contentHash`).
- **Why:** The brief's thread is discover → saved capability → deterministic replay. A silent fallback to a golden made that thread fake.
- **Rejected:** Keeping CONST fallbacks "for demo convenience."

## D-032 — Compiler emits delta checkpoints and ranked locator chains

- **Date:** 2026-09-10
- **Status:** accepted
- **Context:** Schema and REPORT already claimed per-step checkpoints and role → label → text → CSS. The compiler stored primary role+name only.
- **Decision:** After each discovery action, observe again. Checkpoint = first meaningful delta (url, then title, then new text), with goal literals stripped. Every targeted step gets the ranked locator chain.
- **Why:** Replay determinism should come from what the surface actually changed, and locators should degrade in the order D-004 already chose.

## D-033 — Post-handback reconciliation and honest human capture

- **Date:** 2026-09-10
- **Status:** accepted
- **Context:** D-020 always executed the risky step after resume. Auto-resume evidence used the note "operator confirmed on the live session" even when no human clicked. §3.6 asks to record what the human did; we only logged a lock transfer.
- **Decision:** On resume, re-observe, re-run detectors, skip the risky step if its checkpoint already holds (or the operator sent `stepCompletedByHuman` and there is no checkpoint); otherwise execute once. Operator page exposes that signal. Evidence captures url/title/screenshot + a11y-snapshot diff before pause and after handback. Resume notes are literal (`auto-resume`, `operator clicked Resume`) — never fabricated.
- **Why:** The human may have already done the irreversible click. Replaying it would double-submit. Empty diffs under auto-resume are honest.
- **Supersedes:** D-020 (execute-always after resume)

## D-034 — INVALID_INPUT result class

- **Date:** 2026-09-10
- **Status:** accepted
- **Context:** Missing or mistyped params threw inside `materialize`, then the catch-all labeled `status: failed`, `stepId: "uncaught"`.
- **Decision:** Validate parameters before the loop. New result status `invalid_input` with code `INVALID_INPUT` (unknown name, missing value, or non-numeric `number` param). No `stepId` — this is not a UI step failure.
- **Why:** Callers must distinguish "you invoked it wrong" from "the console broke."
- **Supersedes:** D-012's four-status list (now five)

## D-035 — Scripted operators must say so

- **Date:** 2026-09-10
- **Status:** accepted
- **Context:** `humanCompletesRiskyStep` really takes the lock and clicks Confirm, but claim→return is ~200ms. The intervention read as a teller.
- **Decision:** Stamp `operatorKind: "scripted" | "human"` on the intervention and resume decision. Auto-resume and `humanCompletesRiskyStep` are scripted. Operator-console claim/return is human.
- **Why:** The mechanism was honest; the record was not. Timestamps plus this field are the tell.

## D-036 — SQLite core ledger, POST + CSRF, unique dispute_id

- **Date:** 2026-09-10
- **Status:** accepted
- **Context:** Filings lived in a TypeScript array while `filings-proof.json` showed SQL. GET `/submit` filed a dispute. Confirming DSP-1001 twice succeeded twice. Sub-account Confirm was GET and wrote nothing.
- **Decision:** `node:sqlite` in-memory ledger with `UNIQUE(dispute_id)`. Irreversible routes are POST-only with a single-use form token. Sub-account Confirm inserts into `sub_accounts`. Duplicate Confirm returns "Dispute already filed."
- **Why:** The UI drive is the point only if curl GET cannot file. Core must reject what the automation ledger also rejects.

## D-037 — Provenance timestamps come from the run

- **Date:** 2026-09-10
- **Status:** accepted
- **Context:** Capabilities had `discoveredAt` five months before the evidence folder they pointed at, and `approvedAt` before discovery.
- **Decision:** `discoveredAt` is the discovery run clock. `approve` writes `approvedAt` as `new Date()` unless an explicit `at` is passed. Committed artifacts were restamped from their logs.
- **Why:** Provenance is a compliance artifact. A date that cannot be the run it cites is worse than no date.

## D-038 — Engine split: classifier, locators, handoff, compose

- **Date:** 2026-09-10
- **Status:** accepted
- **Context:** `engine.ts` grew past 1,100 lines.
- **Decision:** Extract `classifier.ts` (exception matching + retry class), `locator.ts` (chain + rank telemetry), `handoff.ts` (escalate + reconcile), `compose.ts` (`uses` resolution), `checkpoints.ts` (expect vs observation). The step loop stays in `engine.ts`.
- **Why:** Same behavior, independently testable units.

## D-039 — Tenant overlay is a product, not a footnote

- **Date:** 2026-09-10
- **Status:** accepted
- **Context:** §3.7 is 1/8 of the score. REPORT used to say overlays "would add next."
- **Decision:** `--tenant westside` skins Find Member / Card Claims / Branch Verification / field reorder. Overlay remaps copy and appends the interstitial detector. Same artifact green. `westside-drift` keeps the rank-3 rediscover story.
- **Why:** Copy change is an overlay. Structure change is rediscovery. Both have to run.

## D-040 — Hostile surface and a second Surface

- **Date:** 2026-09-10
- **Status:** accepted
- **Context:** The console was a11y-clean, so ranked locators never met the brief's frameset / generated-id case. The Surface port had one implementation.
- **Decision:** `?legacy=1` is a real frameset with presentation tables, generated ids, duplicate names, and multi-match search. `DesktopSurface` replays lookup against a fake a11y tree.
- **Why:** The locator argument is proven when rank-1 misses and drift fires. The seam is real when a non-Playwright adapter passes the suite.

---

## Template for the next entry

```md
## D-041 — Title

- **Date:** YYYY-MM-DD
- **Status:** accepted
- **Context:** What forced the choice.
- **Decision:** What we did.
- **Why:** The trade-off in one or two sentences.
- **Rejected:** (optional)
- **Supersedes:** D-xxx (optional)
```
