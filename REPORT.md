# REPORT

## 1. Architecture

RelayAI is a single Node process with five seams: **Surface**, **LLM**, **Artifact**, **Policy**, and **Control**. Discovery and replay share the Surface and Policy; only discovery calls an LLM. That is the product claim in code form: the model discovers, the artifact is the capability, replay is production.

A CLI wires the adapters. There is no queue, no service mesh, and no database. Artifacts are versioned JSON on disk so a reviewer (or a calling agent) can read the contract in a PR. The cost of that choice is concurrent writers — irrelevant at this scale, and the brief penalizes premature infrastructure.

The Surface port (`observe` / `act` / `pause` / `resume`) is the heterogeneity boundary. Playwright implements it for this submission; a desktop adapter would not change the artifact or the replay engine. The LLM port is similarly swappable (Anthropic, OpenAI, or a scripted client for tests).

Trade-off: headed Playwright is required for a real live-session handoff, which makes unattended CI use headless plus an auto-resume waiter. I accepted that split rather than fake the session.

## 2. Artifact schema

A capability is a function, not a transcript. The schema (`schemaVersion: "1.0"`) records:

- **Contract** — `id`, `parameters[]`, `outputs[]`, prose `description`
- **Binding** — `app.vendorId` + `surfaceKind`, not a hostname
- **Steps** — ordered actions with ranked locators, optional `inputFrom`, `risk`, and per-step checkpoints
- **Exceptional states** — detectors with an explicit class (`business_outcome` | `recoverable` | `hard_failure`)
- **Success** — a final checkpoint the caller can trust

Locators are a11y-first (`role` + exact `name`), then label, then text, then CSS. CSS is last because legacy cores do not have test IDs and because a broad `cell` name match on a nested table will happily return the outer wrapper. Exact accessible-name matching is what made extract return `$4,250.00` instead of the entire member record — a lesson that belongs in the schema, not a comment.

Discovery values that appear in the goal are lifted into `parameters.*` and stripped from the artifact. `12345` never persists as a literal in a compiled lookup. Sensitive parameter names are flagged and redacted in logs.

Vendor-level exceptional states (not-found, denied, system notice, session expiry) live on the artifact so replay does not have to rediscover them. That is also the multi-tenant hook: a tenant overlay would add detectors, not a new capability.

## 3. Determinism & error handling

Replay never calls the model. It materializes each step from parameters, walks the locator chain, waits for a short settle, and evaluates checkpoints. After every observation it runs exceptional-state detectors *before* acting, so a “Member not found” screen is classified instead of becoming a locator miss on the next extract.

The result contract is the important part:

| Status | Meaning |
|---|---|
| `success` | Checkpoints held; typed outputs returned |
| `business_outcome` | Expected domain result (`MEMBER_NOT_FOUND`, `PERMISSION_DENIED`, validation) |
| `escalated` | Human took (or refused) the live session |
| `failed` | Hard stop with `stepId`, `expected`, `observed`, screenshot |

Recoverable states (the System Notice interstitial) dismiss and **retry the same step**. Treating recovery as `continue` to the next step was an early bug — it would skip work after a dialog. Hard failures (session expiry, locator miss) stop with evidence. UI drift is secondary here and shows up as a locator miss or a failed checkpoint, which is the right signal to re-discover rather than guess.

Wait strategy is deliberately boring: `domcontentloaded` plus a short settle. These apps are slow in the “server think” sense, not in the SPA sense; polling the a11y tree for the checkpoint is more honest than `networkidle`.

## 4. Heterogeneity & multi-tenant

**Surfaces.** The artifact stores intent (click the control whose role is `button` and name is `Search`). The web adapter resolves that through every frame — required for the ticker iframe and for real framesets. A desktop adapter would resolve the same locator against the OS accessibility tree. Playwright calls never leak into the JSON.

**Tenants.** Capabilities bind to `vendorId` (here `relay-core`), not to `https://cu-west.example/servicing`. The entry URL is a step argument that replay can rewrite (`--base-url`), which is how tests hit an ephemeral port and how two institutions on the same vendor would share one flow. Per-tenant overlays I would add next, and did not build: extra interstitial detectors, copy variants on accessible names, and a base-URL. Drift detection is the existing failure signal: checkpoint / locator miss rate on a tenant → flag for re-discovery, do not silently patch CSS.

I implemented one hostile web surface and stopped. The schema does not assume a clean DOM, a single document, or a stable host.

## 5. Escalation & handoff

Control is a first-class session field: `automation` | `human`. Automation must hold the lock to `act`. Escalation writes an intervention (capability, step, URL, reason, screenshot), calls `surface.pause()` on the **same** Playwright page, and waits.

The waiter is the mocked operator UI: a local page (`:3847`) with the intervention payload and Resume / Abort. The human uses the headed bank-console window; this page only transfers the lock. `RELAY_AUTO_RESUME_MS` exists so evidence and tests can exercise the same path without a person. Abort leaves control with the human and returns `escalated`.

Stuck is detected as: max discovery steps, three identical observations, a policy violation, a risky step without `--approve-risky`, or an explicit model `escalate` tool. Risky confirms are conservative: unattended replay *blocks* and escalates rather than clicking Confirm in the dark. After resume, that step is considered approved and replay continues — it does not re-escalate the same click.

What is real: the lock, the same browser context, the intervention record, the human step in the log. What is mocked: co-browse, keystroke capture, and any phone channel.

## 6. Safety

Policy is a YAML allowlist (`policy/allowlist.yaml`): hosts (`localhost` / `127.0.0.1` only) and action types. `about:blank` is exempt so the first navigate is not punished. Leaving the origin is a hard failure, not a warning.

Risk is name-based, not action-based — `click` is not inherently dangerous; `Confirm` / `Delete` / `Approve` are. Discovery may record a risky step; unattended replay will not execute it without `--approve-risky` or a human resume. That is the bank-shaped default: irreversible work is gated, lookup is not.

Redaction runs on every evidence write: SSNs, account-like tokens, bearer values, and keys named `password` / `token` / `ssn`. Compiled artifacts store parameter *references*, not the discovery literals. Limits: this is regex redaction, not a DLP product; a novel identifier format will leak. The allowlist is host-level, not route-level — good enough for a single local console, not for a shared browser that can open `/admin/wire`.

## 7. Cuts

Left out on purpose:

- Desktop surface and multi-tenant runtime (design only; see §4)
- A real operator co-browse console (handoff mechanism is real; UI is a page + the live window)
- Langfuse / CALL-E / queues (observability is JSONL + screenshots; a phone channel would be another `ResumeWaiter`)
- Assisted LLM fallback on replay failure (would blur the “no model in production” line)
- A second *hand-authored* capability (`open-sub-account`) so the risky-path demo does not depend on a key. `verify-and-file-dispute` is now a live OpenAI `gpt-4o` discovery.

Would build next: route-level allowlists, then tenant overlays (canonicalization) if there is time. Replay-N stability (`npm run stability`) is already in the CLI. `/evidence/discovery-verify-and-file-dispute` is the impactful live OpenAI `gpt-4o` run (lookup → verify amount → file → human on Confirm). `/evidence/discovery-lookup-member-savings` is the shorter live lookup. `--scripted` remains the offline / CI path; `npm run evidence` regenerates replay and escalation traces only.
