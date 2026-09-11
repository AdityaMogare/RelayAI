import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const SKIP_RUN = /-\d{4}-\d{2}-\d{2}T/;

type CatalogRow = {
  folder: string;
  scenario: string;
  status: string;
  code: string;
  durationMs: string;
  ranks: string;
  screenshots: string[];
  traces: string[];
};

const SCENARIOS: Record<string, string> = {
  "discovery-lookup-member-savings": "Live gpt-4o lookup discovery",
  "discovery-verify-and-file-dispute": "Live gpt-4o dispute discovery + Confirm pause",
  "discovery-legacy-frameset": "Scripted discovery against a real frameset",
  "discovery-assisted-escalation": "Stuck Help loop; human clicks Search; assistedBy stamped",
  "discovery-assisted-attest": "Supervisor Attestation; teller01 clicks I attest; assistedBy stamped",
  "replay-lookup-success": "Deterministic lookup member 12345",
  "replay-lookup-not-found": "Same artifact, member 99999 → MEMBER_NOT_FOUND",
  "replay-tenant-westside": "One artifact, CU West skin, tenant-14 overlay",
  "replay-drift-rediscovery": "Rank-3 extract fallback → promoteHits v2 → green",
  "replay-session-expired-reauth": "Session dies mid-run; operator Sign In; resume",
  "replay-ambiguous-row": "14 Doe rows; Open scoped to :memberId",
  "policy-blocked-admin-wire": "Click Wire Transfer; Chromium aborts /admin/wire",
  "stability-50": "N=50 lookup soak",
  "escalate-open-sub-account": "Risky Confirm auto-resume",
  "escalate-verify-and-file-dispute": "HITL Confirm; filings count = 1",
  "escalate-human-handoff": "Headed operator-console claim; operatorKind human",
  "replay-verify-dispute-success": "Deterministic DSP-1001 file",
  "replay-verify-dispute-not-found": "DSP-9999 → DISPUTE_NOT_FOUND",
  "replay-recoverable-notice": "?notice=1 dismiss and retry",
  "replay-hard-failure-locator": "Savins Balance locator miss",
  "replay-needs-human-expired": "?expired=1 SESSION_EXPIRED",
  "replay-output-empty-amount": "DSP-1003 empty money cell",
  "replay-recoverable-exhausted": "?notice=always cap",
  "replay-batch-reissue-40": "40 block+reissue invokes, cap lifted",
  "replay-batch-cap-exceeded": "31st invoke hits 30/hr before navigation",
  "replay-batch-idempotency": "Second 4412 reissue; card_actions count = 1",
  "escalate-batch-business-account": "Card 3301 business account → supervisor",
};

function listRuns(root: string): string[] {
  return readdirSync(root)
    .filter((name) => {
      const full = join(root, name);
      return statSync(full).isDirectory() && !SKIP_RUN.test(name) && existsSync(join(full, "result.json"));
    })
    .sort();
}

function readJson(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function locatorRanks(result: Record<string, unknown>): string {
  const hits = result.locatorHits;
  if (!Array.isArray(hits) || hits.length === 0) return "—";
  return hits
    .map((hit) => {
      const rec = hit as { stepId?: string; rank?: number; by?: string };
      return `${rec.stepId ?? "?"} r${rec.rank ?? "?"} ${rec.by ?? ""}`.trim();
    })
    .join(", ");
}

function filesOf(dir: string, test: (name: string) => boolean): string[] {
  return readdirSync(dir)
    .filter(test)
    .sort()
    .map((name) => `${basename(dir)}/${name}`);
}

function rowFor(root: string, folder: string): CatalogRow {
  const dir = join(root, folder);
  const result = readJson(join(dir, "result.json"));
  const metrics = (result.metrics ?? {}) as { durationMs?: number };
  const duration =
    typeof metrics.durationMs === "number"
      ? `${metrics.durationMs} ms`
      : folder === "stability-50"
        ? String((result as { p50DurationMs?: number }).p50DurationMs ? `p50 ${(result as { p50DurationMs?: number }).p50DurationMs} ms` : "—")
        : "—";
  return {
    folder,
    scenario: SCENARIOS[folder] ?? folder,
    status: String(result.status ?? (result as { rate?: number }).rate ?? "—"),
    code: String(result.code ?? "—"),
    durationMs: duration,
    ranks: locatorRanks(result),
    screenshots: filesOf(dir, (n) => /\.(png|gif)$/i.test(n)),
    traces: filesOf(dir, (n) => n === "log.jsonl" || n === "result.json" || n.endsWith(".json")),
  };
}

function escape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function renderEvidenceIndex(root = resolve(process.cwd(), "evidence")): string {
  const rows = listRuns(root).map((folder) => rowFor(root, folder));
  const costPath = join(root, "cost-comparison.json");
  const cost = existsSync(costPath) ? readFileSync(costPath, "utf8") : "";
  const body = rows
    .map((row) => {
      const shots = row.screenshots
        .map((src) => `<a href="${escape(src)}"><img src="${escape(src)}" alt="${escape(src)}" onerror="this.style.display='none'"></a>`)
        .join(" ");
      const traces = row.traces.map((src) => `<a href="${escape(src)}">${escape(src.split("/").pop() ?? src)}</a>`).join(" · ");
      return `<tr>
        <td><code>${escape(row.folder)}/</code></td>
        <td>${escape(row.scenario)}</td>
        <td><strong>${escape(row.status)}</strong></td>
        <td><code>${escape(row.code)}</code></td>
        <td>${escape(row.durationMs)}</td>
        <td class="ranks">${escape(row.ranks)}</td>
        <td class="shots">${shots || "—"}</td>
        <td>${traces}</td>
      </tr>`;
    })
    .join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>RelayAI evidence catalog</title>
  <style>
    body { font: 14px/1.45 system-ui, sans-serif; margin: 24px; color: #1a1a1a; background: #f7f4ea; }
    h1 { font-size: 22px; }
    p { max-width: 70em; }
    table { border-collapse: collapse; width: 100%; background: #fff; }
    th, td { border: 1px solid #cfc8a8; padding: 8px 10px; vertical-align: top; text-align: left; }
    th { background: #1f4a7a; color: #fff; }
    code { font-size: 12px; }
    img { max-width: 160px; max-height: 100px; border: 1px solid #bbb; }
    .ranks { font-size: 12px; }
    pre { background: #fff; border: 1px solid #cfc8a8; padding: 12px; overflow: auto; }
  </style>
</head>
<body>
  <h1>RelayAI evidence</h1>
  <p>Static catalog of committed runs. Open this file; no server required. Failure and handoff stills cited in REPORT are committed; other PNGs stay local. GIFs are committed.</p>
  <table>
    <thead>
      <tr>
        <th>Run</th><th>Scenario</th><th>Status</th><th>Code</th><th>Duration</th><th>Locator ranks</th><th>Screenshots</th><th>Trace</th>
      </tr>
    </thead>
    <tbody>
      ${body}
    </tbody>
  </table>
  ${cost ? `<h2>Discovery vs replay cost</h2><pre>${escape(cost)}</pre>` : ""}
</body>
</html>
`;
}

export function writeEvidenceIndex(root = resolve(process.cwd(), "evidence")): string {
  const html = renderEvidenceIndex(root);
  const path = join(root, "index.html");
  writeFileSync(path, html, "utf8");
  return path;
}
