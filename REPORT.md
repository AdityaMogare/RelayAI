# REPORT

## 1. Architecture

One Node process. No queue, no service mesh, no application database. Nothing
here needs them, and building them would have been the wrong signal.

There are two paths through the code and they share almost nothing:

- **Discovery** runs once. It's slow, it costs money, it uses an LLM.
- **Replay** runs forever. It's fast, it's free, it never touches a model.

Between them sits one file. It is the only thing that crosses.

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
   ║  THE SEAM                ║                   │       └──────┬───────┘
   ╚═══╦══════════════════╦═══╝                   │              ▼
       ▲                  ▲                       │       ┌──────────────┐
   review +         overlays/tenants/*.yaml       │       │ Operator     │─▶ 👤
   approve          (cannot change risk)          │       │  :3847       │◀─
   (2 people)                                     ▼       └──────────────┘
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
        REPLAY ────┘
```

That split is the bet this project makes. **If the recording is detailed enough,
replay never needs the model.** If it isn't, you quietly put an agent back into
production and lose the thing you were trying to gain.

**Five boundaries.** Surface (how we see and act on a screen), LLM (which model,
or none), Artifact (the recording), Policy (what's allowed), Control (who's
driving). Both paths go through Surface and Policy. Only discovery touches LLM.
The replay engine does not import Playwright.

**Two stores, on purpose.** Capabilities are JSON files reviewed in a pull
request. Runs that change something append a line to `runs/ledger.jsonl`. One is
an editable contract, the other is an audit trail you never edit. Putting both in
Postgres would mix them up.

**State between chained capabilities** lives in two places: the live browser
session, and a bag of typed outputs passed along. `uses` runs a child capability
on the same session — which is why `verify-and-file-dispute` starts at step
`s03`: the member search belongs to `lookup-member-savings` and was never
re-recorded.

**The trade-off I accepted.** A real handoff needs a visible browser, so it can't
run headless in CI. Rather than fake it, CI runs a scripted operator and those
runs are labelled `operatorKind: "scripted"`. One run with a real person is
committed separately.

---

## 2. Artifact schema

A capability is a function, not a keystroke recording. You should be able to open
one JSON file with no code in front of you and answer five questions: what does
it do, what does it need, what does it give back, what does it break, who made it.

Here's the real one, with what each part is for and who reads it:

```jsonc
{
  "schemaVersion": "1.1",
  "id": "verify-and-file-dispute",

  // Read by a CALLING AGENT, before it invokes.
  "sideEffects": {
    "kind": "irreversible",
    "compensation": "Teller withdraws the case from the dispute queue in the core.
                     Automation cannot un-file a Confirm."
  },

  // Read by the ENGINE, before step 1.
  "preconditions": {
    "requiresSession": true,
    "requiresRole": "teller",
    "entryCheckpoint": { "kind": "textIncludes", "expect": "Savings Balance" }
  },

  // Chaining. The child runs on the SAME browser session.
  "uses": [{ "capabilityId": "lookup-member-savings", "pass": ["memberId"] }],

  // Read by a HUMAN or an auditor.
  "provenance": { "discoveredAt", "discoveredBy", "model": "gpt-4o",
                  "promptHash", "evidenceRunId", "goal" },

  "auth":     { "credentialRef": "vault://tenant-9/teller" },
  "approval": { "requestedBy": "analyst@relay", "approvedBy": "risk@relay" },

  // Which inputs form the duplicate-detection key. `reason` is deliberately
  // excluded: re-filing the same transaction with a different reason is still
  // the same filing.
  "idempotencyKeyFrom": ["memberId", "merchant", "last4"],

  "parameters": ["memberId", "merchant", "last4", "reason"],
  "outputs": [
    { "name": "transactionAmount", "type": "money",  "pii": true, "locator": {...} },
    { "name": "confirmation",      "type": "string", "pii": true, "locator": {...} }
  ],

  "steps": [ /* s03-disputes, s04-open-row, s06-extract-amount, s07-file,
                s08-reason, s09-continue, s10-confirm, s11-extract */ ],

  "exceptionalStates": [ /* MEMBER_NOT_FOUND, PERMISSION_DENIED, VALIDATION_ERROR,
                            SYSTEM_NOTICE, SESSION_EXPIRED, CORE_UNAVAILABLE,
                            DISPUTE_NOT_FOUND, DISPUTE_ALREADY_FILED */ ],
  "antiCheckpoints": [{ "expect": "Wrong screen" }, { "expect": "Screen not found" }],
  "success": { "checkpoint": { "kind": "textIncludes", "expect": "Dispute filed" } }
}
```

And one step in full:

```jsonc
{
  "id": "s06-extract-amount",
  "action": "extract",
  "outputName": "transactionAmount",
  "risk": "safe",
  "timeoutMs": 8000,
  "retryBudget": 3,
  "target": {
    "primary":   { "by": "role",  "role": "cell", "name": "Transaction Amount" },
    "fallbacks": [
      { "by": "label", "name": "Transaction Amount" },
      { "by": "text",  "text": "Transaction Amount" },
      { "by": "css",   "selector": "[aria-label=\"Transaction Amount\"]" }
    ]
  },
  "checkpoint": { "kind": "textIncludes", "expect": "Transaction Amount" }
}
```

**Four ways to find every control, best first.** Role and exact name, then label,
then visible text, then CSS. CSS is last because legacy screens have no stable
IDs. But the real reason for ranking isn't "a backup might save the run" — it's
that **using a backup is a signal**. Succeed on rank 3 and confidence drops and
the capability is flagged for re-recording. The fallback chain is a drift sensor
that happens to also be a safety net.

Queue rows are a fifth shape, not a fifth rank: `cellInRow` names the column
inside the row that matches runtime inputs (`merchant`, `last4`). The four-rank
chain still runs on the control it finds.

**Checkpoints are derived, not hand-written.** At compile time we diff the screen
before an action against the screen after and take the first thing that changed:
URL, then title, then newly-appeared text. Goal values are stripped first, so
`12345` never gets baked into an assertion.

**Typed outputs.** `money` becomes `{ currency: "USD", minor: 4218 }`. A calling
agent never receives the string `"$42.18"` from something the contract called
money. `pii: true` means the field is stripped from evidence **by name** — not by
a regex hoping to recognise a dollar amount.

**The goal doesn't contain a dispute ID.** Parameters are `merchant` and `last4`,
and step `s04-open-row` picks the matching row out of the queue. That's how a
real servicing screen works — you search and click a row — and it's why the
locators have to be able to depend on runtime inputs.

**Migration.** `1.x` only adds fields. `migrate()` upgrades an old file at load
time, so a 1.0 recording still runs. A `2.0` would be breaking, and the loader
throws `UNSUPPORTED_SCHEMA` rather than guessing.

---

## 3. Determinism & error handling

Replay loads the file discovery wrote, logs its SHA-256, and never calls a model.
`npm run verify` proves both halves: the hash on `discover.end` equals the hash
on `replay.start`, and two replays produce byte-identical traces once timestamps,
run IDs and ports are normalised away.

**The order of operations is the design.** Cheapest and most protective first:

```
   kill switch / rate limit   →  stops in ~5ms, stepId "governance", no browser
              ▼
   validate inputs            →  invalid_input, with the exact violation
              ▼
   idempotency key            →  IDEMPOTENCY_CONFLICT, even with --approve-risky
              ▼
   resolve tenant overlay
              ▼
   assert entry precondition  →  PRECONDITION_FAILED at the door
              ▼
   step loop
```

Inside each step:

```
  ┌─▶ observe()
  │        ▼
  │   CLASSIFY known screens   ◀── BEFORE acting. This is the whole trick.
  │        │
  │   ┌────┴──────┬────────────┬──────────────┬─────────────┐
  │   ▼           ▼            ▼              ▼             ▼
  │ business   recoverable  transient    hard_failure   needs_human
  │ outcome    dismiss +    backoff      stop +         ops ticket,
  │ → return   RETRY SAME   200/400/     evidence       not engineering
  │   cleanly  STEP         800ms
  │        ▼
  │   anti-checkpoint? ──yes──▶ fail closed ("Wrong screen")
  │        ▼
  │   risky & unapproved? ──yes──▶ ControlPlane ──▶ human ──▶ "I did it" ─▶ SKIP
  │        ▼
  │   materialize params → policy check → act()
  │        │                                │
  │        │                    walk ranked locators,
  │        │                    RECORD WHICH RANK MATCHED
  │        ▼
  │   coerce typed output   "$42.18" → { USD, 4218 }
  │        │                 empty? → OUTPUT_INVALID, even if the page looks fine
  │        ▼
  │   checkpoint holds?
  │        │
  │   ┌────┴────┐
  │   yes      no ──▶ was the step risky?
  └───┘                  │
   next step        ┌────┴────┐
                   yes        no
                    │          │
     CHECKPOINT_AFTER_ACT   CHECKPOINT_FAILED
     ambiguous: true + idempotencyKey
```

**Classify before acting.** I had this backwards at first. Act first and a
"Member not found" screen sails past, then step 4 fails to find a field that was
never going to be there. You get a locator miss and go hunting for a broken
selector when the real answer is "that member doesn't exist."

The result contract:

| Status | Means |
|---|---|
| `success` | Checks held, typed outputs returned |
| `business_outcome` | A real answer — "no such member", "already filed" |
| `dry_run` | Stopped before the irreversible part; says what it would have done |
| `invalid_input` | Bad parameters. Not a UI problem, so no step ID |
| `escalated` | A human has, or refused, the session |
| `failed` | Engineering ticket — locator miss, wrong screen, bad value |
| `needs_human` | Ops ticket — session died, popup won't leave |

Those last two are a **routing decision**. Merging them means someone reads a
session timeout as a bug in the recording.

**Retry depends on the class.** A 503 backs off 200/400/800ms. A known popup is
dismissed and the **same step** is retried. A locator miss after the page has
settled is deterministic and does not get a second click. Business outcomes never
retry. The word "same" in "retry the same step" is doing real work — treating a
dismissed popup as "move on" silently skipped work in an early version.

**The case most systems get wrong.** Dispute `DSP-1003` renders perfectly. The
"Transaction Amount" heading is present so the checkpoint passes — but the cell
is empty because the mainframe behind it timed out. A screen-only runner calls
that a success and returns nothing. We fail it with `OUTPUT_INVALID`, because the
declared type is `money` and it parsed to empty. **You judge on the value, not
the page.**

**When I can't tell.** If a risky click returns OK but the checkpoint doesn't
hold, I don't know whether the money moved. That returns `ambiguous: true` plus
the idempotency key. A retry with that key is safe; a blind second Confirm is how
you open two accounts.

**Honest non-determinism:** wall-clock settle waits, browser render timing, the
fake core's case-number generator (disputes fixture `CASE-77201`; cards mint
`CASE-88xxx`).

### Every class, with a recorded run

| Class | Example | Evidence |
|---|---|---|
| success | member 12345 | `replay-lookup-success/` |
| business_outcome | member 99999 | `replay-lookup-not-found/` |
| business_outcome | second Confirm of DSP-1001 | `replay-verify-dispute-already-filed/` |
| dry_run | stop before Confirm | verify row `dispute dry-run` |
| invalid_input | missing `memberId` | verify row `lookup invalid-input` |
| recoverable | `?notice=1`, dismissed, same step retried | `replay-recoverable-notice/` |
| recoverable, capped | `?notice=always` | `replay-recoverable-exhausted/` |
| failed | misspelt locator | `replay-hard-failure-locator/` |
| failed | blank amount, DSP-1003 | `replay-output-empty-amount/` |
| failed | `GET /admin/wire` aborted | `policy-blocked-admin-wire/` |
| needs_human | `?expired=1` | `replay-needs-human-expired/` |
| escalated | card 3301, supervisor | `escalate-batch-business-account/` |
| rate limited | 31st run in an hour | `replay-batch-cap-exceeded/` |
| idempotency | second 4412 reissue | `replay-batch-idempotency/` |

---

## 4. Heterogeneity & multi-tenant

**Surfaces.** The recording stores intent — "click the control whose role is
button and whose name is Search" — not Playwright calls. The web adapter resolves
that through every frame, which the frameset skin requires. `DesktopSurface`
resolves the same locators against an accessibility tree and runs the same lookup
capability (`npm run desktop-replay`). The engine imports neither.

**Tenants.** Capabilities bind to a vendor product, not a hostname. Differences
live in YAML a non-engineer can read:

```
   base recording          recorded once against Demo CU
         │
         ▼  vendor pack         overlays/vendors/relay-core.yaml
         │
         ▼  tenant overlay      overlays/tenants/tenant-14.yaml
         │                        copy: { Confirm: Submit Request }
         ▼  run params          --base-url --input --tenant
         │
         ▼
   resolved capability

   CAN change:  control names, extra detectors
   CANNOT:      risk, steps, sideEffects, id, vendorId
                (strict schema + re-assert after the rename)
```

That last constraint is the point. Renaming "Confirm" to "Submit Request" must
not be able to turn the dangerous button into a safe one.

One recording runs green against Demo CU, CU West (Find Member / Submit Request)
and Westside (different wording, extra popup, fields reordered).
`npm run portability` prints what matched first-choice, what fell back, and what
the overlay overrode.

**Knowing before a customer calls.** The ledger records which rank each locator
matched and whether checks failed. `npm run drift -- --tenant tenant-9` scores
recent runs and flags re-discovery. Same signal as the per-run confidence score,
pointed at a tenant. `npm run rediscover` then replays the old file on the
drifted skin, records a v2, diffs the two, and replays the new one.
`evidence/rediscover-verify-and-file-dispute/` is that loop.

**Before running somewhere new,** `npm run probe` checks the entry screen
read-only. If it doesn't match, we don't find out by clicking Confirm in the
wrong app.

---

## 5. Escalation & handoff

Who is driving is an explicit field: `automation` or `human`. `Surface.act()`
refuses when automation doesn't hold the lock, so this is enforced rather than
agreed.

```
  automation                 ControlPlane          operator :3847        human
      │                           │                      │                 │
      │ reaches s10-confirm       │                      │                 │
      ├───── escalate ───────────▶│                      │                 │
      │                           ├── raised ───────────▶│                 │
      │                           │   why / step / url / │                 │
      │                           │   screenshot / the   │                 │
      │                           │   check it wants     │                 │
      │◀── capture "before" ──────┤                      │                 │
      │    url+title+png+a11y     │                      │◀── claim ───────┤
      │                           │◀── in_control ───────┤    teller01     │
      │  pause() — SAME page,     │                      │                 │
      │  red banner, session id   │                      │ clicks Confirm  │
      │  control = human          │                      │ in THAT window  │
      │  act() REFUSES            │                      │                 │
      │                           │◀── returned ─────────┤◀─ "I did it" ───┤
      │◀── disposition ───────────┤   completed_by_human │                 │
      │◀── capture "after" + diff ┤                      │                 │
      │  resume()                 │                      │                 │
      │                           │                      │                 │
      │  RE-OBSERVE · re-run detectors · re-assert checkpoint              │
      │       │                   │                      │                 │
      │  already holds ──▶ SKIP the click                │                 │
      │                           │                      │                 │
      │  (scripted dispute run: filings DSP-1001 count = 1)                │
      │                           │                      │                 │
      └── nobody claims in 120s ─▶ abandoned, risky step NOT executed
```

The lifecycle is real, not a flag:

```
raised → claimed(operatorId) → in_control → returned(disposition) → resolved
   └──────────── TTL 120s ─────────────────────────────────────▶ abandoned
```

Handing back offers three answers: **I did it** (skip), **I didn't** (do it
once), **abort**. That third option is the fix for the worst bug in the first
version — automation clicked Confirm again after a person already had. In a bank
that's a duplicate filing.

**What the human did** is recorded as data: URL, title, screenshot and an
accessibility-tree diff, before and after. The operator's note is not the proof.

**One at a time.** A session can be held by one intervention. A second capability
escalating on the same surface is abandoned with a pointer to the holder
(`SESSION_HELD`). Dispute filings outrank account openings; lookups still
enqueue, they just wait behind them.

`evidence/escalate-verify-and-file-dispute/` is the skip path
(`operatorKind: "scripted"`, filings count = 1). `evidence/escalate-human-handoff/`
is a real person (`operatorKind: "human"`): teller01 claimed, the two-minute wait
ran out, Confirm was not pressed.

Discovery can hand off the same way. If the model is stuck, a teller acts on the
live session and the compiled file stamps `assistedBy`
(`evidence/discovery-assisted-attest/`).

**Real:** the lock, the same browser context, the lifecycle record, operator
identity, the disposition, the TTL, before/after capture, the skip decision, and
the count in the database on the scripted dispute run. **Mocked:** co-browsing,
keystroke capture, a phone channel.

---

## 6. Safety

**Allowing hosts is not a guardrail.** The agent shares a browser with
`/admin/wire`. So the allowlist is method plus path, default deny, enforced by
aborting the request in the browser itself:

```
   every HTTP request from the page
              ▼
   ┌────────────────────────┐
   │ page.route("**/*")     │   method + path glob, DEFAULT DENY
   │   assertRequest()      │
   └──────┬──────────┬──────┘
       allowed     denied
          ▼          ▼
      continue   abort("blockedbyclient")
```

```yaml
allowedRoutes:
  - { method: POST, path: "/member/*/disputes/*/submit" }
deniedRoutes:
  - { method: "*",  path: "/admin/**" }
```

Could this agent reach the wire-transfer screen? No — and that's a mechanism, not
a promise.

**Credentials are references.** `vault://tenant-9/teller` resolves into memory at
run time. The secret never lands in a recording, a log, or a screenshot caption.

**Redaction is structural.** Outputs carry `pii: true` and are stripped by name.
Regex is a backstop for SSNs and tokens, and I'll say what it misses: names and
amounts. That's exactly why we classify instead of guessing.

**Risk is decided at review time.** Guessing from a button's name is how "Submit
search" becomes dangerous and "Post payment" becomes safe. The flag lives on the
reviewed recording; `npm run review` fails if a Confirm step is marked safe.

**Two people for irreversible work.** `requestedBy` must differ from `approvedBy`.

**Brakes.** 30 runs per capability per hour, 120 per tenant, plus an off switch
that needs no deploy. Governance is checked before the browser opens, so a capped
run costs 5 milliseconds.

**Retention.** Evidence expires after 14 days. Only the screenshots the docs
point at are committed; the rest are generated and purged.

---

## 7. Cuts

Left out on purpose:

- **A real co-browsing operator console.** The handoff mechanism is real; the UI
  is a page plus the live window.
- **Queues, dashboards, hosted infrastructure.** Nothing here needs them at this
  size, and building them would have been the wrong signal.
- **Letting the model help during replay when a step breaks.** This is the one I
  most wanted and deliberately didn't build. A bounded, policy-checked retry
  would fix a real class of small breakages — and it would put a model back into
  production, which is the exact thing this design exists to avoid. If I added
  it, it would be a separate labelled mode, never the default, and every firing
  would land in the ledger.
- **Keystroke capture during a handoff.** We record before/after state and the
  accessibility diff instead.

**Known rough edges.** The exceptional-state list has duplicate codes from
merging the vendor set with the dispute set — harmless at runtime since the first
match wins, but visible in a file a reviewer reads. Step IDs have gaps (`s05` is
missing) because the compiler numbers from the recorded run and some steps get
dropped.

**Next, in order:** tenant ops owning the overlay YAML rather than engineers
re-recording; a small operator queue UI on top of the priorities that already
exist; and output *rules* rather than just types, so a capability can declare
"this amount must be positive".

**Two bugs I found in my own tooling, which say more than the features do.**

The evidence generator shared one console process across scenarios, and one
scenario deliberately skipped its state reset — so a later run tried to file a
dispute an earlier run had already filed, and wrote a **failure** into a folder
this document described as a success. Evidence generation is hermetic per
scenario now.

Separately, the cost table claimed discovery took 10.7 hours and replay was
9,018× faster. The duration was measured to the last line of the log, and the
generator appends a hash-stamp event days later. The true figures are 16.8
seconds and about 4× — far less impressive and actually true. There's a
regression test against the committed log.

Neither bug was in the system. Both were in how I measured it, which is the
failure mode I was least worried about, because I'd never written a test for it.
A write-up is a claim and a committed run is evidence, and when they disagree you
believe the run.

---

## Requirement → implementation → evidence

| Requirement | Code | Evidence |
|---|---|---|
| §3.1 goal-driven loop | `agent/discover.ts`, `providers.ts` | `discovery-verify-and-file-dispute/`, `discovery-assisted-attest/` |
| §3.2 typed artifact | `artifact/{schema,compile,ranked,checkpoint}.ts` | `capabilities/*.json` |
| §3.3 deterministic replay | `replay/{engine,normalize,roundtrip}.ts` | verify round-trip + determinism rows |
| §3.3 error handling | `replay/{classifier,retry,outputs}.ts` | class table in §3 |
| §3.4 allowlist | `policy/{routes,policy}.ts`, `surfaces/web.ts` | `safety.test.ts`, `policy-blocked-admin-wire/` |
| §3.4 secrets & PII | `policy/{vault,redact}.ts` | redacted `result.json` files |
| §3.5 evidence | `evidence/{store,catalog}.ts` | `evidence/index.html` |
| §3.6 escalation | `escalation/{control,lifecycle,operator}.ts`, `replay/handoff.ts` | `escalate-human-handoff/`, `escalate-verify-and-file-dispute/` |
| §3.7 heterogeneity | `overlay/*`, `surfaces/desktop.ts`, `replay/{probe,drift,portability}.ts` | tenant + desktop verify rows, `rediscover-verify-and-file-dispute/` |
