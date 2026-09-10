import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { LOOKUP_MEMBER_SAVINGS, OPEN_SUB_ACCOUNT, VERIFY_AND_FILE_DISPUTE } from "../src/artifact/compile.ts";
import { ControlPlane, immediateResume } from "../src/escalation/control.ts";
import { EvidenceStore } from "../src/evidence/store.ts";
import { ReplayEngine } from "../src/replay/engine.ts";
import { WebSurface } from "../src/surfaces/web.ts";
import { startConsole } from "../apps/bank-console/server.ts";

const ROOT = resolve(process.cwd(), "evidence");

function reset(runId: string): EvidenceStore {
  const dir = resolve(ROOT, runId);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return new EvidenceStore(runId, ROOT);
}

async function withSurface<T>(fn: (surface: WebSurface) => Promise<T>): Promise<T> {
  const surface = new WebSurface();
  await surface.launch();
  try {
    return await fn(surface);
  } finally {
    await surface.close();
  }
}

const consoleServer = await startConsole(0);
const baseUrl = consoleServer.origin;
console.log(`console ${baseUrl}`);

try {
  // Preserve committed live-model discovery transcripts. Replay and
  // escalation traces below do not call a model, so clones without a key
  // can still regenerate them via `npm run evidence`.
  console.log("discovery preserved (live-model evidence in discovery-lookup-member-savings/ and discovery-verify-and-file-dispute/)");

  await withSurface(async (surface) => {
    const evidence = reset("replay-lookup-success");
    const result = await new ReplayEngine(surface, evidence).run(LOOKUP_MEMBER_SAVINGS, {
      inputs: { memberId: "12345" },
      baseUrl,
    });
    console.log("replay success", result.status, result.outputs);
  });

  await withSurface(async (surface) => {
    const evidence = reset("replay-lookup-not-found");
    const result = await new ReplayEngine(surface, evidence).run(LOOKUP_MEMBER_SAVINGS, {
      inputs: { memberId: "99999" },
      baseUrl,
    });
    console.log("replay not-found", result.status, result.code);
  });

  await withSurface(async (surface) => {
    const evidence = reset("escalate-open-sub-account");
    const control = new ControlPlane(surface, evidence, immediateResume("operator confirmed on the live session"));
    const result = await new ReplayEngine(surface, evidence).run(OPEN_SUB_ACCOUNT, {
      inputs: { memberId: "12345", product: "Share Savings" },
      baseUrl,
      control,
    });
    console.log("escalate", result.status, control.lastIntervention?.reason);
  });

  await withSurface(async (surface) => {
    const evidence = reset("replay-verify-dispute-success");
    const result = await new ReplayEngine(surface, evidence).run(VERIFY_AND_FILE_DISPUTE, {
      inputs: { memberId: "12345", disputeId: "DSP-1001", reason: "Unauthorized" },
      baseUrl,
      approveRisky: true,
    });
    console.log("dispute success", result.status, result.outputs);
  });

  await withSurface(async (surface) => {
    const evidence = reset("replay-verify-dispute-not-found");
    const result = await new ReplayEngine(surface, evidence).run(VERIFY_AND_FILE_DISPUTE, {
      inputs: { memberId: "12345", disputeId: "DSP-9999", reason: "Unauthorized" },
      baseUrl,
      approveRisky: true,
    });
    console.log("dispute not-found", result.status, result.code);
  });

  writeFileSync(
    resolve(ROOT, "README.md"),
    `# Evidence

Generated against the local Relay Credit Union console.

| Run | What it shows |
|---|---|
| \`discovery-verify-and-file-dispute/\` | **Impact path.** OpenAI \`gpt-4o\` discovers a teller scenario: lookup Jane Doe → open DSP-1001 → verify amount → file Unauthorized → human resume on Confirm. Not \`--scripted\`. \`npm run evidence\` leaves live discovery folders alone. |
| \`discovery-lookup-member-savings/\` | Observe → **OpenAI \`gpt-4o\`** decide → act on a live Playwright session, then a compiled capability. Not \`--scripted\`. |
| \`replay-lookup-success/\` | Deterministic replay of \`lookup-member-savings\` with \`memberId=12345\`. No LLM. |
| \`replay-lookup-not-found/\` | Same capability, \`memberId=99999\`, classified as \`business_outcome\` / \`MEMBER_NOT_FOUND\`. |
| \`escalate-open-sub-account/\` | Replay of a risky Confirm step: automation pauses the same session, a human resume is recorded, then the run completes. |
| \`replay-verify-dispute-success/\` | Deterministic replay of \`verify-and-file-dispute\` for \`DSP-1001\`. No LLM. Confirm is approved via \`--approve-risky\`. |
| \`replay-verify-dispute-not-found/\` | Same capability, \`disputeId=DSP-9999\`, classified as \`business_outcome\` / \`DISPUTE_NOT_FOUND\`. |

The reviewable capabilities also live at \`/capabilities/*.json\`.
`,
  );
} finally {
  await consoleServer.close();
}
