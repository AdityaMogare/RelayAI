# Evidence

Generated against the local Relay Credit Union console.

| Run | What it shows |
|---|---|
| `discovery-verify-and-file-dispute/` | **Impact path.** OpenAI `gpt-4o` discovers a teller scenario: lookup Jane Doe → open DSP-1001 → verify `$42.18` → file Unauthorized → **human resume on Confirm** → extract case number. Parameterized `memberId`, `disputeId`, `reason`. Screenshot `risky.png`. Not `--scripted`. |
| `discovery-lookup-member-savings/` | Shorter live OpenAI `gpt-4o` run: search → extract savings. Also `{ provider, model, scripted: false }`. |
| `replay-lookup-success/` | Deterministic replay of `lookup-member-savings` with `memberId=12345`. No LLM. |
| `replay-lookup-not-found/` | Same capability, `memberId=99999`, classified as `business_outcome` / `MEMBER_NOT_FOUND`. |
| `escalate-open-sub-account/` | Replay of a risky Confirm step: automation pauses the same session, a human resume is recorded, then the run completes. |
| `replay-verify-dispute-success/` | Deterministic replay of `verify-and-file-dispute` for `DSP-1001`. No LLM. Confirm is approved via `--approve-risky`. |
| `replay-verify-dispute-not-found/` | Same capability, `disputeId=DSP-9999`, classified as `business_outcome` / `DISPUTE_NOT_FOUND`. |

`npm run evidence` regenerates replay and escalation traces only. Live discovery folders are not overwritten.

The reviewable capabilities also live at `/capabilities/*.json`.
