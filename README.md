# RelayAI

A computer-use system for the long tail of bank back-office apps that have no API: an LLM discovers a flow once, the run is compiled into a typed capability, and production invokes that capability by deterministic replay — no model in the loop.

This is a take-home vertical slice, not a product. It automates a local credit-union servicing console (hostile markup, no test IDs, iframe, seeded exception states).

## What it does

1. **Discover** — observe → decide → act against a live UI until the goal is met.
2. **Compile** — write a versioned, parameterized capability (not a model transcript).
3. **Replay** — execute the capability with typed inputs; classify success, business outcomes, recoverable interstitials, and hard failures.
4. **Escalate** — pause the *same* live session, hand it to a human, record what they did, resume.

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env   # add ANTHROPIC_API_KEY (or OPENAI_API_KEY) for live discovery
```

Node 20+. Discovery needs a model key. Replay, tests, and the evidence generator do not.

## Demo path

Terminal 1 — start the stand-in core:

```bash
npm run console
# Relay Credit Union console: http://127.0.0.1:3000
```

Terminal 2 — discover a **real servicing scenario** (live model). Jane Doe called about an unauthorized ACME POS charge; the agent must look up the member, open the dispute, verify `$42.18`, file it, and pause on irreversible Confirm:

```bash
RELAY_AUTO_RESUME_MS=1500 npm run discover -- \
  --goal 'Jane Doe (member 12345) reported an unauthorized ACME POS charge. Look up the member, open Disputes, find DSP-1001, read the transaction amount, and file the dispute with reason "Unauthorized".' \
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
```

Without a model key, the same loop runs offline with a scripted policy:

```bash
npm run discover -- \
  --goal "Look up member 12345 and read their current savings balance" \
  --target http://127.0.0.1:3000 \
  --id lookup-member-savings \
  --scripted
```

Replay — no LLM:

```bash
npm run replay -- --capability lookup-member-savings --input memberId=12345
npm run replay -- --capability lookup-member-savings --input memberId=99999
npm run replay -- --capability verify-and-file-dispute \
  --input memberId=12345 --input disputeId=DSP-1001 --input reason=Unauthorized \
  --approve-risky
npm run replay -- --capability verify-and-file-dispute \
  --input memberId=12345 --input disputeId=DSP-9999 --input reason=Unauthorized
```

`memberId=99999` is a **business outcome** (`MEMBER_NOT_FOUND`), not a crash. `DSP-9999` is `DISPUTE_NOT_FOUND`.

Human handoff on a risky confirm (headed browser + operator page at `http://127.0.0.1:3847`):

```bash
npm run escalate-demo
# or, for a non-interactive capture:
RELAY_AUTO_RESUME_MS=8000 npm run escalate-demo -- --auto-resume-ms 8000
```

Agent-facing catalog (stretch, thin):

```bash
npm run capabilities -- list
npm run capabilities -- invoke --id lookup-member-savings --input memberId=12345
```

Replay stability (stretch M10):

```bash
npm run stability -- --capability lookup-member-savings --input memberId=12345 --runs 5
```

## Seeded console states

| Member / ID | What happens |
|---|---|
| `12345` | Jane Doe — savings `$4,250.00` |
| `67890` | John Smith — no disputes |
| `55555` | Permission denied |
| `99999` | Member not found |
| `DSP-1001` | Open dispute on Jane Doe — `$42.18` ACME POS |
| `DSP-1002` | Already filed — `DISPUTE_ALREADY_FILED` |
| `DSP-9999` | Dispute not found |
| `?notice=1` | System Notice dialog (recoverable) |
| `?expired=1` | Session expired (hard failure) |
| `?slow=1` | Artificial slowness |

Open a sub-account from a member record, or file a card dispute; **Confirm** is treated as irreversible.

## Tests (offline except Playwright)

```bash
npm test
```

Unit tests use a fake surface and a scripted LLM. Integration tests drive Chromium against a fresh in-process console. Nothing calls a model API.

Regenerate replay and escalation traces in `/evidence` (live browser, no LLM). The committed discovery transcript is a live-model run and is not overwritten:

```bash
npm run evidence
```

## Layout

```
apps/bank-console/   local credit-union console
src/core/            Surface + LLM ports
src/surfaces/        Playwright + a11y adapter, mock adapter
src/artifact/        Zod schema, compiler, store
src/replay/          deterministic executor + result taxonomy
src/policy/          allowlist + redaction
src/escalation/      control lock + operator page
src/agent/           discovery loop
capabilities/        versioned JSON capabilities
evidence/            discovery + replay + escalation traces
policy/allowlist.yaml
REPORT.md            design write-up
Decision.md          append-only log of choices (D-001…)
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
| `RELAY_AUTO_RESUME_MS` | Auto-resume an escalation (CI / evidence) |
