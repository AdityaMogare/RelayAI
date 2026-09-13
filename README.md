# RelayAI

[![CI](https://github.com/AdityaMogare/RelayAI/actions/workflows/ci.yml/badge.svg)](https://github.com/AdityaMogare/RelayAI/actions/workflows/ci.yml)

Banks run a lot of old software that has no API. The only way in is the screen a
staff member uses. RelayAI gives an AI agent hands for those systems.

It works in two halves. An LLM drives the real screens **once** and figures out
how to do the job. What it learned is saved as a file, and from then on that file
does the job **with no LLM involved at all**.

The second half is the point. Running a model on every transaction is slow, costs
money each time, and can do something slightly different twice in a row. None of
that is acceptable inside a bank.

---

## Run it first, read second

```bash
npm ci && npm run verify        # 27 scenarios, no API key, ~40 seconds
```

That runs the whole system against a local fake bank and prints a pass/fail
table. If it's green on your machine, everything below this line is true on your
machine.

```
discovery   gpt-4o   16.8s   13 model calls   $0.09
replay      none      4.3s    0 model calls   $0.00   $0.00 per invoke after recording
replay ×50  none     76.3s    0 model calls   $0.00   50/50 success, 0% fallbacks
```

Discovery happened once. Every run since has been free. A servicing rep doing
this by hand is about six minutes a case.

---

## The whole system on one screen

```
   "file the ACME dispute for Jane Doe"          invoke(id, {memberId, merchant,
                    │                                        last4, reason})
                    ▼                                          ▼
 ┌──────────────────────────────┐            ┌──────────────────────────────┐
 │  DISCOVERY                   │            │  REPLAY                      │
 │  once · 17s · $0.09 · 13 LLM │            │  always · 4s · $0.00 · 0 LLM │
 │                              │            │                              │
 │   observe ─▶ decide ─▶ act   │            │   govern ─▶ validate ─▶      │
 │      ▲                  │    │            │   idempotency ─▶ overlay ─▶  │
 │      └──────────────────┘    │            │   precondition ─▶ STEP LOOP  │
 │            │ compile()       │            │                              │
 └────────────┼─────────────────┘            └────┬──────────────┬──────────┘
              ▼                                   │              │ risky
   ╔══════════════════════════╗                   │              │ or stuck
   ║  capabilities/X.json     ║ ─────────────────▶│              ▼
   ║  sha256: e072c3dd45b4…   ║   load + verify   │       ┌──────────────┐
   ║                          ║      same hash    │       │ ControlPlane │
   ║  THE SEAM — the only     ║                   │       └──────┬───────┘
   ║  thing that crosses      ║                   │              │ pause the
   ╚═══╦══════════════════╦═══╝                   │              │ SAME session
       ▲                  ▲                       │              ▼
       │                  │                       │       ┌──────────────┐
   review +         overlays/tenants/*.yaml       │       │ Operator     │─▶ 👤
   approve          rename controls, add          │       │  :3847       │◀─
   (2 people)       screens — CANNOT              │       └──────────────┘
                    change risk                   ▼
                                          ┌──────────────────────┐
                                          │  RunResult — 7 kinds │
                                          └──────────┬───────────┘
                       ┌─────────────────────────────┼────────────────┐
                       ▼                             ▼                ▼
                runs/ledger.jsonl            evidence/<run>/      drift score
                idempotency + audit          log, png, result     → rediscover


   Both paths reach the app the same way:

        DISCOVERY ─┐
                   ├─▶  Surface port  ─▶  Policy  ─▶  [ Legacy bank UI ]
        REPLAY ────┘    observe/act       route allowlist    frameset, no test IDs,
                        web|desktop|mock   DEFAULT DENY       3 tenant skins
```

Everything left of the double bar happens once. Everything right of it happens in
production. The JSON file is the only thing that crosses.

---

## What's in the box

There's no real bank to test against, so the repo ships a small fake one you run
on your laptop. It's deliberately awkward in the ways real bank software is:

- no automation-friendly IDs on anything
- element IDs that change on every page load (`ctl00_ctl32_dgAcct_ctl04_lblVal`)
- an old frameset layout (`?legacy=1`)
- a login that times out after 90 seconds
- three visual skins of the same product, like three institutions running the
  same vendor software

Four saved capabilities run against it:

| Capability | Does | Blast radius |
|---|---|---|
| `lookup-member-savings` | Reads a balance | none |
| `open-sub-account` | Opens an account | irreversible |
| `verify-and-file-dispute` | Finds a charge, checks the amount, files it | irreversible |
| `block-and-reissue-card` | Blocks a card, orders a replacement | irreversible |

---

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env     # OPENAI_API_KEY or ANTHROPIC_API_KEY, for discovery only
```

Node 22 or newer. The fake bank stores data with `node:sqlite`, built into
Node 22, so there's no database to install. Replay, the tests and `npm run verify`
need no API key. A `Dockerfile` is there if you want the console in a container
(`npm run docker:smoke`).

---

## The main demo

**Terminal 1 — start the fake bank:**

```bash
npm run console          # http://127.0.0.1:3000
```

**Terminal 2 — let the model work out a job (about 9 cents):**

```bash
npm run discover -- \
  --goal 'Jane Doe (member 12345) reported an unauthorized charge from ACME POS on
          her card ending 4412. Find that transaction, verify the amount, and file
          it as Unauthorized.' \
  --target http://127.0.0.1:3000 \
  --id verify-and-file-dispute \
  --headed
```

Notice the goal doesn't contain a dispute ID. The agent has to search the queue
and pick the right row — which is why the saved recording has a step called
`s04-open-row` and takes `merchant` and `last4` as inputs.

No API key? Same loop, scripted instead of a model:

```bash
npm run discover -- --goal "Look up member 12345 and read their savings balance" \
  --target http://127.0.0.1:3000 --id lookup-member-savings --scripted
```

**Now replay it. No model, four seconds:**

```bash
npm run replay -- --capability capabilities/verify-and-file-dispute.json \
  --input memberId=12345 --input merchant="ACME POS" --input last4=4412 \
  --input reason=Unauthorized --approve-risky
```

Same file, different inputs, and the answers you don't want:

```bash
# "no such member" — a real answer, returned cleanly, not a crash
npm run replay -- --capability capabilities/lookup-member-savings.json --input memberId=99999

# see what it would do without doing the irreversible part
npm run replay -- --capability capabilities/verify-and-file-dispute.json \
  --input memberId=12345 --input merchant="ACME POS" --input last4=4412 \
  --input reason=Unauthorized --dry-run
```

---

## The human handoff

Some steps shouldn't happen without a person.

```bash
npm run escalate-demo    # operator page at http://127.0.0.1:3847
```

That pauses `open-sub-account` on Confirm. Pass
`--capability capabilities/verify-and-file-dispute.json` to pause a filing
instead.

What you'll see:

```
  1. browser stops on the confirm screen, red banner with the session ID
  2. operator page shows why it stopped, plus a screenshot
  3. you claim it as teller01
  4. you click Confirm yourself IN THAT SAME WINDOW
  5. you hand back saying "I already did it"
  6. automation re-observes, sees the work is done, DOES NOT CLICK
```

If it was a dispute, `SELECT count(*) FROM filings WHERE dispute_id='DSP-1001'`
is then 1. That skip path is recorded in
`evidence/escalate-verify-and-file-dispute/` (`operatorKind: "scripted"`).

If nobody turns up within two minutes the run is abandoned and the button is
**not** pressed. `evidence/escalate-human-handoff/` is a real person claiming as
teller01 and then the wait running out (`operatorKind: "human"`). Confirm was
not pressed.

Discovery can stop for a person too. If the model hits a screen it doesn't know,
a teller clicks through on the same session and the file stamps `assistedBy`.
`evidence/discovery-assisted-attest/` is that.

---

## One recording, several institutions

The lookup capability was recorded once against Demo CU. CU West runs the same
vendor product with different wording. That's one line of YAML, not a new
recording:

```yaml
# overlays/tenants/tenant-14.yaml
copy:
  Search: Find Member
  Member Lookup: Find a Member
  Confirm: Submit Request
```

```bash
npm run overlay     -- --capability capabilities/open-sub-account.json --tenant tenant-14
npm run probe       -- --capability capabilities/lookup-member-savings.json --tenant tenant-14 --input memberId=12345
npm run portability -- --capability capabilities/lookup-member-savings.json --input memberId=12345
npm run drift       -- --tenant tenant-9
npm run rediscover  -- --capability capabilities/verify-and-file-dispute.json --scripted
npm run desktop-replay      # same capability, a non-browser surface
```

Overlays can rename controls and add error screens. They **cannot** change which
steps are dangerous — that's re-checked after the rename, because the whole point
of "Confirm" becoming "Submit Request" is that it's still the dangerous button.
When a tenant has drifted too far, `npm run rediscover` records a v2 against that
skin. Replay still never calls a model.

---

## Volume, and the brakes

```bash
npm run capabilities -- invoke --id block-and-reissue-card --input memberId=12345 --input last4=4412
npm run stability    -- --capability capabilities/lookup-member-savings.json --input memberId=12345 --runs 50
```

There's a cap of 30 runs per capability per hour and 120 per tenant.
`evidence/replay-batch-cap-exceeded/` shows the 31st run being stopped in 5
milliseconds, before the browser even opens, with nothing written.

---

## Safety controls

```bash
npm run review      # fails if a Confirm step is marked safe
npm run approve -- --capability open-sub-account --requested-by analyst@relay --approved-by risk@relay
npm run kill    -- --capability open-sub-account     # off switch, no deploy
npm run audit   -- --member 12345 --from 2026-09-08 --to 2026-09-09
npm run evidence:purge                                # 14-day retention
```

The browser physically blocks any request to a page that isn't allowed, so the
agent cannot reach `/admin/wire` even by accident. Passwords are references to a
vault, never written into a file. Customer values are marked sensitive and
stripped from logs by name, not by a regex hoping to spot a dollar amount.

---

## The fake bank's test cases

| Input | What happens |
|---|---|
| `12345` | Jane Doe, savings `$4,250.00` |
| `67890` | John Smith |
| `55555` | Permission denied |
| `99999` | Member not found |
| `DSP-1001` | Open dispute, `$42.18` ACME POS |
| `DSP-1002` | Already filed (filing DSP-1001 twice also lands here) |
| `DSP-1003` | Page looks fine, amount cell is blank (the interesting one) |
| `4412 / 7788 / 3301` | Normal card / already blocked / business account, supervisor needed |
| `?notice=1` | Popup you can dismiss |
| `?notice=always` | Popup that never goes away |
| `?expired=1` | Session died |
| `?expireMid=1` | Session dies after Search; a person can sign back in |
| `?flaky=1` | Two 503s, then works |
| `?legacy=1` | Frameset, no labels, changing IDs |
| `?tenant=westside` | A third institution's wording |

---

## Tests

```bash
npm test            # 190 tests, 28 files
npm run verify      # the 27-scenario table
npm run evidence    # regenerate every recorded run (real browser, slow)
```

CI runs typecheck, tests and verify on every push. No API key needed.

---

## Where things live

```
apps/bank-console/   the fake bank (3 skins, legacy mode, login, sqlite)
src/core/            the two swappable interfaces: Surface and LLM
src/surfaces/        Playwright adapter, desktop adapter, fake adapter for tests
src/agent/           the discovery loop
src/artifact/        the recording format, compiler, hashing, migration
src/replay/          the no-model executor and the error classification
src/escalation/      the human handoff
src/policy/          allowed routes, risky actions, secrets, redaction
src/overlay/         per-institution differences
src/evidence/        run folders, catalog, 14-day retention
overlays/            per-institution YAML
policy/              allowlist and rate-limit levers
capabilities/        4 saved recordings
evidence/            32 recorded runs — start with evidence/index.html
tests/               190 tests
scripts/             evidence generator, docker smoke
REPORT.md            how it's built and why
DECISIONS.md         what I chose, what it cost
```

## Settings

| Variable | What it does |
|---|---|
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | Live discovery only |
| `RELAY_LLM_PROVIDER` / `RELAY_MODEL` | Which model discovers (Anthropic if that key is set, else OpenAI `gpt-4o`) |
| `RELAY_HEADED=1` | Show the browser |
| `RELAY_CONSOLE_PORT` | Fake bank port (default 3000) |
| `RELAY_OPERATOR_PORT` | Operator page (default 3847) |
| `RELAY_BIND_HOST` | Console bind address (`0.0.0.0` in Docker) |
| `RELAY_INTERVENTION_TTL_MS` | How long to wait for a human (default 120000) |
| `RELAY_VAULT_tenant_9_teller` | Credential for `vault://tenant-9/teller`. Never logged. |
