# Run ledger

Capabilities live in `capabilities/*.json` and are reviewed in PRs like code.

Runs are a different lifecycle: append-only operational data. Successful mutating
replays append one line to `ledger.jsonl` keyed by `capabilityId` +
`idempotencyKey` (hash of the declared `idempotencyKeyFrom` inputs).

A second replay of an irreversible capability with the same key is refused
(`IDEMPOTENCY_CONFLICT`) even if the caller passes `--approve-risky`.
`--approve-risky` gates the click; the ledger gates the duplicate.

A sample line is committed so a fresh clone can `npm run audit`. Live mutating
runs append. Other files under `runs/` stay gitignored. Do not put this in a
database — the two stores exist because artifacts are edited and reviewed,
while runs are only ever appended.
