# Decisions

What I chose, what else was on the table, what it cost, and when I'd change my
mind. Newest at the bottom.

---

**D-001 — TypeScript on Node 22, one process, no framework**

One language across the fake bank, the agent and the tests, and a reviewer can
run everything with `npm ci`. Node 22 also ships `node:sqlite`, so the fake core
gets a real database with no extra dependency.

*Also considered:* Python — better agent libraries, worse browser story for me.
*Cost:* Node 22 is a hard floor. Node 20 will not run this.
*Revisit:* if a deployment target pins an older Node.

---

**D-002 — The recording is data, not generated code**

A capability is a JSON file, not a generated Playwright test.

I want a human to review it in a pull request, a calling agent to read it at run
time, and a migration to be able to upgrade it. Generated code gives none of
those — you'd be diffing a script instead of a contract.

*Cost:* the engine has to interpret the file, and a team can't drop it into their
own test suite.
*Revisit:* if someone asks for a test file, emit one *from* the JSON. The JSON
stays the source of truth.

---

**D-003 — Recordings in files, run history in an append-only log**

Two kinds of data, two lifecycles. A capability gets edited and reviewed. A run
record never changes and gets audited. So capabilities are files in git and runs
are lines in `runs/ledger.jsonl`.

*Also considered:* both in Postgres.
*Cost:* no query layer, no concurrent writers. Neither matters at this size.
*Revisit:* more than one person recording capabilities for the same vendor.

---

**D-004 — Find controls by accessibility role and name first, CSS last**

Four ways to find every control, best first: role + exact name, then label, then
visible text, then CSS.

Legacy bank screens have no automation IDs and their markup changes for reasons
unrelated to meaning. The accessibility tree is what a screen reader sees, and
it's also what a desktop app exposes — so the same idea works on both surfaces.

The second reason matters more: **falling back is a signal**. A run that succeeds
on the CSS fallback isn't healthy, it's warning me. Drift detection came out of
this almost for free.

*Cost:* depends on the app exposing names at all. A canvas-only app needs vision.
*Revisit:* the first surface with no accessibility layer.

---

**D-005 — Replay never calls a model, full stop**

The value of the project is that production is cheap, fast and repeatable. A
model in the replay path gives all three back.

*Also considered:* a small bounded LLM retry when a step fails. I wanted it.
*Cost:* a tiny UI change that a model could shrug off instead forces a
re-recording.
*Revisit:* if re-discovery latency hurts more than the purity helps — and then
it's a separate labelled mode, never the default, with every firing in the ledger.

---

**D-006 — Check for known screens *before* acting, not after failing**

After every observation, run the detectors first.

I had this backwards at first and it produced nonsense. A "Member not found"
screen would sail past, and then the next step would fail to find a field that
was never going to be there. The error you get is a locator miss, which sends you
hunting for a broken selector when the real answer is "that member doesn't exist."

*Cost:* one extra observation per step.
*Revisit:* never. Best ordering change in the engine.

---

**D-007 — "No such member" is an answer, not an error**

Separate classes instead of success/failure: a real business answer, something
recoverable, something transient, an engineering failure, and something ops needs
to look at.

The last split is the one people skip. "The locator broke" and "the session died"
both stop the run but go to different teams. Merging them means someone reads a
timeout as a bug in the recording.

*Cost:* more statuses for a caller to handle.

---

**D-008 — Judge on the value, not on the screen**

Dispute `DSP-1003` renders perfectly — the "Transaction Amount" heading is right
there, so the checkpoint passes — but the cell is empty because the mainframe
behind it timed out.

A system that only looks at screens calls that a success and returns nothing. We
fail it, because the output was declared `money` and it didn't parse.

*Cost:* you have to declare output types up front.
*Revisit:* extend from types to rules — "this amount must be positive".

---

**D-009 — Retry depends on the class, not a blanket count**

A 503 backs off and tries again. A known popup is dismissed and the **same step**
is retried. A locator miss after the page has settled is deterministic and gets
no second click.

I originally treated a dismissed popup as "move to the next step", which quietly
skipped work. The word "same" is doing real work in that sentence.

---

**D-010 — After a risky click with a failed check, admit I don't know**

If Confirm returns OK but the check afterwards doesn't hold, I cannot tell from
the screen whether the money moved. That case returns `ambiguous: true` with an
idempotency key.

A retry with that key is safe. A second blind Confirm is how you open two
accounts.

*Cost:* the caller has to keep the key.

---

**D-011 — The artifact declares which inputs form the idempotency key**

`idempotencyKeyFrom: ["memberId", "merchant", "last4"]` — and `reason` is
deliberately excluded.

Deriving the key from *all* inputs looked simpler, and it's wrong: re-filing the
same transaction with a different reason is still the same filing, and it should
collide. Which fields identify the real-world action is a property of the flow,
so the flow declares it.

*Cost:* one more field a recorder has to get right. `review` should probably
check it; it doesn't yet.

---

**D-012 — Decide what's dangerous at review time, not at run time**

Risk lives on the reviewed recording. The runtime never inspects a button's name.

Keyword matching is how "Submit search" becomes irreversible and "Post payment"
becomes safe. Both are wrong; the second is dangerous.

*Cost:* a step marked wrong replays as marked. The approval gate and
`npm run review` are what catch that.

---

**D-013 — The goal doesn't hand over an ID**

The dispute goal says "the unauthorized charge from ACME POS on the card ending
4412" rather than "DSP-1001". Parameters are `merchant` and `last4`, and step
`s04-open-row` picks the matching row out of the queue.

Handing the agent an ID would have made discovery easy and the recording
unrealistic. Real servicing screens make you search and click a row. This forced
locators that can depend on runtime inputs, which is the harder and more honest
version.

*Cost:* a more fragile discovery run and more compiler work.

---

**D-014 — The handoff happens on the same session, and the human can say "I already did it"**

Giving a person a fresh browser throws away the state that made the escalation
necessary. So automation pauses the same page and the operator works in that
window.

Handing back offers three answers: I did it, I didn't, abort. That third option
is the fix for the worst bug in the first version — automation clicked Confirm
again after a person had already confirmed. In a bank that's a duplicate filing.

*Cost:* a real handoff needs a visible browser, so CI runs a scripted operator.
Those runs are labelled `operatorKind: "scripted"`; one run with a real person is
committed separately.

---

**D-015 — Record what the human did as data, not as a note**

URL, title, screenshot and an accessibility-tree diff, before and after. The
operator's comment is not evidence.

---

**D-016 — If nobody comes, give up without pressing the button**

The waiter used to spin forever. Unattended, that's a browser holding a live
teller session indefinitely. Now it's 120 seconds, then abandon — and abandoning
does **not** execute the risky step.

---

**D-017 — Block requests in the browser, not in a helper function**

The allowlist is method plus path, default deny, enforced by aborting the request
at the browser layer.

Allowing hosts isn't a guardrail when the agent shares a browser with
`/admin/wire`. "Could this ever reach the wire-transfer screen" should have a
mechanical answer, not a reassuring one.

---

**D-018 — Classify sensitive fields; don't pattern-match for them**

Outputs are marked `pii: true` and stripped by name. Regex stays as a backstop
for SSNs and tokens.

Regex will not find "Jane Doe" or "$4,250.00". Pretending otherwise is worse than
admitting it, so the REPORT says what it misses.

---

**D-019 — Per-institution differences go in YAML that isn't code**

Overlays rename controls and add error screens. Resolution is base → vendor pack
→ tenant overlay → run parameters.

Overlays cannot change which steps are risky. That's enforced by a strict schema
plus a re-check after the rename — because the whole point of renaming "Confirm"
to "Submit Request" is that it's still the dangerous button.

*Cost:* someone maintains overlays. That's the trade I want: tenant ops editing a
line of YAML beats an engineer re-recording.

---

**D-020 — Volume needs brakes**

30 runs per capability per hour, 120 per tenant, plus an off switch that needs no
deploy. Governance runs before the browser opens, so a capped run costs 5
milliseconds.

A bug that loops replay is an incident without this. I'd rather refuse work than
do it ten thousand times.

---

**D-021 — Evidence generation has to be hermetic**

The generator shared one console process across all scenarios, and one scenario
deliberately skipped its state reset. A later run then tried to file a dispute an
earlier run had already filed — and wrote a **failed** result into a folder this
project's write-up described as a success.

Nothing was wrong with the system. The instrument was contaminated. Every
scenario resets its own state now.

*What I took from it:* when a document and a committed run disagree, the run is
right.

---

**D-022 — Seven answers, not two**

Callers get `success`, `business_outcome`, `dry_run`, `invalid_input`,
`escalated`, `failed`, and `needs_human`.

`failed` is an engineering ticket. `needs_human` is an ops ticket. `dry_run` is
"I would have clicked Confirm." `invalid_input` never has a step ID, because
nothing on the screen went wrong.

*Cost:* more statuses for a caller to handle.
*Revisit:* never merge `failed` and `needs_human` again.

---

**D-023 — Discovery can ask a person too**

If the model hits a screen it doesn't know, a teller acts on the same session
and the compiled file stamps `assistedBy`. Re-recording a drifted tenant is a
labelled command (`npm run rediscover`), not a model sneaking into replay.

*Cost:* one more path in discovery evidence.
*Revisit:* if assisted steps become common, the review gate should require a
human to look at `assistedBy` before approve.

---

**D-024 — Schema 1.1 only adds fields**

`1.0` files still load. `migrate()` fills the new required fields in memory. A
`2.0` throws `UNSUPPORTED_SCHEMA` rather than guessing.

*Cost:* the loader is a read adapter, not a rewrite of git.
*Revisit:* the first breaking change to the step vocabulary.

---

**D-025 — A queue row is found from inputs, not from a baked-in ID**

`cellInRow` names the column inside the row that matches runtime values
(`merchant`, `last4`). The four-rank chain still runs on the control it finds.

Without that, `s04-open-row` would need a dispute ID in the recording, which is
the easier and less honest version.

*Cost:* locators that expand parameters at replay.
*Revisit:* a surface where tables have no accessible cells.

---

