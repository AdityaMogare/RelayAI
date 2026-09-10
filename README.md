# RelayAI

[![CI](https://github.com/AdityaMogare/RelayAI/actions/workflows/ci.yml/badge.svg)](https://github.com/AdityaMogare/RelayAI/actions/workflows/ci.yml)

A computer-use system for the long tail of bank back-office apps that have no API: an LLM discovers a flow once, the run is compiled into a typed capability, and production invokes that capability by deterministic replay — no model in the loop.

This is a take-home vertical slice, not a product. It automates a local credit-union servicing console. The default skin is the modern recorded chrome (so the three golden capabilities stay green). `?legacy=1` is a real frameset with sibling-cell balances and rotating ASP.NET ids; `?tenant=westside` is a third skin on the same process. Auth (`startConsole(0, { auth: true })`) is `/login` + a 90s session cookie.

## What it does

1. **Discover** — observe → decide → act against a live UI until the goal is met. `--id X` writes `capabilities/X.json`.
2. **Compile** — write a versioned, parameterized capability (not a model transcript), with per-step checkpoints and ranked locators.
3. **Replay** — `replay --capability capabilities/X.json`; classify success, business outcomes, invalid input, recoverable interstitials, `needs_human`, and hard failures. Money outputs are `{ currency, minor }`. Both traces log the artifact content hash.
4. **Escalate** — pause the *same* live session, capture what the human did, resume; replay re-observes and skips the risky step if the checkpoint already holds.

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env   # add ANTHROPIC_API_KEY (or OPENAI_API_KEY) for live discovery
```

Node 20+. Discovery needs a model key. Replay, tests, and the evidence generator do not.

## Docker

Teammates can try the console, tests, and replay without a local Node/Playwright install. Chromium is in the image. Headed browser windows are not available — discovery and escalation run headless (use `RELAY_AUTO_RESUME_MS` for the confirm handoff).

```bash
docker compose up --build
# Credit-union console: http://localhost:3000
```

If host port 3000 is already taken, change the left-hand side in `docker-compose.yml` (`"3001:3000"`).

```bash
# Tests + lookup/dispute replay in one shot
docker compose --profile smoke run --rm smoke
```

With the console already up:

```bash
docker compose exec console npm test
docker compose exec console npm run replay -- --capability capabilities/lookup-member-savings.json --input memberId=12345
docker compose exec console npm run replay -- --capability capabilities/lookup-member-savings.json --input memberId=99999
docker compose exec console npm run replay -- --capability capabilities/verify-and-file-dispute.json \
  --input memberId=12345 --input merchant="ACME POS" --input last4=4412 --input reason=Unauthorized \
  --approve-risky
```

Optional discovery — Compose reads `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` from a local `.env`. Playwright inside the container uses `http://127.0.0.1:3000`; browse `http://localhost:3000` on the host.

```bash
docker compose exec console npm run discover -- \
  --goal "Look up member 12345 and read their current savings balance" \
  --target http://127.0.0.1:3000 \
  --id lookup-member-savings
# add --scripted if you have no model key
```

## Demo path

Terminal 1 — start the stand-in core:

```bash
npm run console
# Relay Credit Union console: http://127.0.0.1:3000
```

Terminal 2 — discover a **real servicing scenario** (live model). The goal names a person, a merchant, and a last-4 — not a DSP- id. The agent must search the queue for the ACME POS row:

```bash
RELAY_AUTO_RESUME_MS=1500 npm run discover -- \
  --goal 'Jane Doe called about an unauthorized charge from ACME POS on her card ending 4412. Find that transaction, verify the amount, and file it as Unauthorized.' \
  --target http://127.0.0.1:3000 \
  --id verify-and-file-dispute \
  --max-steps 20 \
  --headed
```

Short lookup path (also a live-model run in `/evidence`):

```bash
npm run discover -- \
  --goal "Look up member 12345 and read their current savings balance" \
  --target http://127.0.0.1:3000 \
  --id lookup-member-savings \
  --headed
# writes capabilities/lookup-member-savings.json (hash logged on discover.end)
```

Without a model key, the same loop runs offline with a scripted policy:

```bash
npm run discover -- \
  --goal "Look up member 12345 and read their current savings balance" \
  --target http://127.0.0.1:3000 \
  --id lookup-member-savings \
  --scripted
```

Replay — no LLM. Same file discover wrote (`contentHash` is in both traces):

```bash
npm run replay -- --capability capabilities/lookup-member-savings.json --input memberId=12345
npm run replay -- --capability capabilities/lookup-member-savings.json --input memberId=99999
npm run replay -- --capability capabilities/verify-and-file-dispute.json \
  --input memberId=12345 --input merchant="ACME POS" --input last4=4412 --input reason=Unauthorized \
  --dry-run
# stops before Confirm; returns transactionAmount and wouldExecute
npm run replay -- --capability capabilities/verify-and-file-dispute.json \
  --input memberId=12345 --input merchant="ACME POS" --input last4=4412 --input reason=Unauthorized \
  --approve-risky
npm run replay -- --capability capabilities/verify-and-file-dispute.json \
  --input memberId=12345 --input merchant=NO-SUCH --input last4=0000 --input reason=Unauthorized
```

`memberId=99999` is a **business outcome** (`MEMBER_NOT_FOUND`), not a crash. `merchant=NO-SUCH` is `DISPUTE_NOT_FOUND`.

The closed loop — replay on a drifted tenant, re-discover, replay green:

```bash
npm run replay -- --capability capabilities/verify-and-file-dispute.json \
  --input memberId="Jane Doe" --input merchant="ACME POS" --input last4=4412 --input reason=Unauthorized \
  --tenant westside-drift --approve-risky
# rank-3 text fallbacks → needsRediscovery (exit 1)
npm run rediscover -- --capability capabilities/verify-and-file-dispute.json --tenant westside-drift --scripted
# compiles v2 against westside names, diffs v1→v2, replays green
```

Same goal, two models (needs API keys). The compiler is what makes the artifacts equivalent, not the model:

```bash
npm run discover -- --provider openai --model gpt-4o --goal '...' --target http://127.0.0.1:3000 --id verify-and-file-dispute
npm run discover -- --provider anthropic --model claude-sonnet-4-20250514 --goal '...' --target http://127.0.0.1:3000 --id verify-and-file-dispute-claude
```

Human handoff on a risky confirm (headed browser + operator page at `http://127.0.0.1:3847`). Claim as `teller01`, do the work on the live window, then return `completed_by_human` / `not_done` / `abort`. Unattended, `RELAY_INTERVENTION_TTL_MS` (default 120s) abandons and releases the teller session:

```bash
npm run escalate-demo
# or, for a non-interactive capture:
RELAY_AUTO_RESUME_MS=8000 npm run escalate-demo -- --auto-resume-ms 8000
```

The reviewable HITL artifact is `/evidence/escalate-verify-and-file-dispute`: the waiter takes the lock and clicks Confirm (`operatorKind: "scripted"`), automation skips, and `filings-proof.json` is a real `node:sqlite` count. A headed operator-console claim stamps `human`. Open `evidence/index.html` for the full catalog.

Agent-facing catalog:

```bash
npm run capabilities -- tools --id lookup-member-savings
npm run capabilities -- list
npm run capabilities -- invoke --id lookup-member-savings --input memberId=12345
```

Replay stability (stretch M10):

```bash
npm run stability -- --capability capabilities/lookup-member-savings.json --input memberId=12345 --runs 5
```

## Multi-tenant (one artifact, two skins)

The lookup capability was recorded once against Demo CU (tenant-9). CU West (tenant-14) is the same Relay Core product with different chrome and labels (`Search` → `Find Member`, `Confirm` → `Submit Request`). The overlay is YAML a non-engineer can edit:

```bash
npm run overlay -- --capability capabilities/open-sub-account.json --tenant tenant-14
npm run probe -- --capability capabilities/lookup-member-savings.json --tenant tenant-14 --input memberId=12345
npm run portability -- --capability capabilities/lookup-member-savings.json --input memberId=12345
npm run replay -- --capability capabilities/lookup-member-savings.json --input memberId=12345 --tenant westside --probe
npm run rediscover -- --capability capabilities/lookup-member-savings.json --tenant westside-drift --scripted
npm run drift -- --tenant tenant-9
npm run desktop-replay
```

`overlays/tenants/tenant-14.yaml` is the smallest change for a renamed Confirm. Resolution is base artifact → vendor pack → tenant overlay → run params; overlays cannot change `risk`.

Safety (M6):

```bash
npm run review
npm run approve -- --capability open-sub-account --requested-by analyst@relay --approved-by risk@relay
npm run audit -- --member 12345 --from 2026-09-08 --to 2026-09-09
npm run kill -- --capability open-sub-account   # no deploy; edits policy/runtime.yaml
npm run evidence:purge                          # TTL 14 days
```

## Seeded console states

| Member / ID | What happens |
|---|---|
| `12345` | Jane Doe — savings `$4,250.00` |
| `last=Doe` | 14 Doe rows (Jane is not first); Open is disambiguated by Member ID |
| `67890` | John Smith — no disputes |
| `55555` | Permission denied |
| `99999` | Member not found |
| `DSP-1001` | Open dispute on Jane Doe — `$42.18` ACME POS |
| `DSP-1002` | Already filed — `DISPUTE_ALREADY_FILED` |
| `DSP-1003` | Dispute screen loads; amount cell empty (mainframe timeout) → `OUTPUT_INVALID` |
| `DSP-9999` | Dispute not found |
| `?notice=1` | System Notice dialog (recoverable: dismiss, retry same step) |
| `?notice=always` | Interstitial returns every time → `RECOVERABLE_EXHAUSTED` / `needs_human` |
| `?expired=1` | Session expired (`needs_human`, not a locator ticket) |
| `?expireMid=1` | Search succeeds, then session expires; Sign In resumes to the pending member |
| `/legacy` | Hostile `<frameset>` skin (banner / nav / work) |
| `Wire Transfer` | Chrome link to `/admin/wire` — allowlist aborts the request |
| `?wrong=1` | Anti-checkpoint: Wrong screen |
| `?flaky=1` | First two hits HTTP 503 (transient backoff), then serves the page |
| `?slow=1` | Artificial slowness |

Open a sub-account from a member record, or file a card dispute; **Confirm** is treated as irreversible.

## Tests (offline except Playwright)

Reviewer command — no model key, no browser. Green table covering every scenario, plus the hash through-line. Pass `--json` for an agent-parseable object (every command accepts it):

```bash
npm run verify
npm run -s verify -- --json
```

The round-trip row is the proof that `discover.end contentHash` equals `replay.start contentHash`. A CSS fallback on an otherwise-successful run is a FAIL on `locator fallback flags drift` (needs re-discovery, confidence < 1). Dry-run stops before Confirm and still returns the transaction amount.

```bash
npm test
```

GitHub Actions runs `npm run typecheck`, `npm test`, and `npm run verify` on every push. Clone, `npm ci`, `npm test`, `npm run verify` — green in under five minutes, no API key except for live discovery.

Unit tests use a fake surface and a scripted LLM. Integration tests drive Chromium against a fresh in-process console. Nothing calls a model API.

Regenerate replay and escalation traces in `/evidence` (live browser, no LLM). The committed discovery transcript is a live-model run and is not overwritten:

```bash
npm run evidence
```

## Layout

```
apps/bank-console/   local credit-union console
src/core/            Surface + LLM ports
src/surfaces/        Playwright web adapter, mock adapter, desktop a11y-tree adapter
src/artifact/        Zod schema, compiler, store
src/replay/          deterministic executor + result taxonomy
src/policy/          allowlist + redaction
src/escalation/      control lock + operator page
src/agent/           discovery loop
capabilities/        versioned JSON capabilities (the contract)
overlays/            vendor packs + tenant copy remaps (diffable YAML)
runs/                append-only run ledger (operational; not reviewed like code)
evidence/            discovery + replay + escalation traces
policy/allowlist.yaml
policy/runtime.yaml    kill switch, blast-radius, 14-day evidence TTL
Dockerfile           Playwright image for team try-out
docker-compose.yml   console + smoke profile
REPORT.md            design write-up
```

## Configuration

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | Live discovery |
| `RELAY_LLM_PROVIDER` | `anthropic` (if `ANTHROPIC_API_KEY` is set) or `openai` |
| `RELAY_MODEL` | Override model id |
| `RELAY_HEADED=1` | Show the browser |
| `RELAY_CONSOLE_PORT` | Console bind (default 3000) |
| `RELAY_OPERATOR_PORT` | Operator page (default 3847) |
| `RELAY_BIND_HOST` | Listen address (`127.0.0.1` locally, `0.0.0.0` in Docker) |
| `RELAY_AUTO_RESUME_MS` | Auto-resume an escalation (CI / evidence) |
| `RELAY_INTERVENTION_TTL_MS` | Unattended escalation TTL (default 120000); then abandon + release session |
| `RELAY_OPERATOR_ID` | Default operator id on the claim form |
| `RELAY_CONSOLE_SKIN` | `cu-west` serves the tenant-14 chrome (Find Member / Submit Request) |
| `RELAY_VAULT_tenant_9_teller` | `username:secret` for `vault://tenant-9/teller`. Never logged. |
