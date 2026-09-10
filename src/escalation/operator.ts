import http from "node:http";
import type { InterventionRequest } from "../core/types.ts";
import type { ResumeDecision, ResumeWaiter } from "./control.ts";

export function createOperatorWaiter(opts: {
  port?: number;
  autoResumeMs?: number;
}): ResumeWaiter {
  return async (req) => {
    const port = opts.port ?? Number(process.env.RELAY_OPERATOR_PORT ?? 3847);
    let decision: ResumeDecision | undefined;

    const html = operatorHtml(req);
    const server = http.createServer((incoming, res) => {
      if (incoming.method === "POST" && incoming.url === "/resume") {
        decision = { action: "resume", note: "operator clicked Resume" };
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<p>Control returned to automation. You can close this tab.</p>");
        return;
      }
      if (incoming.method === "POST" && incoming.url === "/abort") {
        decision = { action: "abort", note: "operator aborted the run" };
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<p>Run aborted.</p>");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    });

    await new Promise<void>((resolve, reject) => {
      server.listen(port, "127.0.0.1", () => resolve());
      server.on("error", reject);
    });

    const origin = `http://127.0.0.1:${port}`;
    console.log(`\nOperator console: ${origin}`);
    console.log("Use the live browser window, then Resume or Abort.\n");

    if (opts.autoResumeMs && opts.autoResumeMs > 0) {
      setTimeout(() => {
        decision ??= { action: "resume", note: `auto-resume after ${opts.autoResumeMs}ms` };
      }, opts.autoResumeMs);
    }

    while (!decision) {
      await new Promise((r) => setTimeout(r, 200));
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return decision;
  };
}

function operatorHtml(req: InterventionRequest): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>RelayAI Operator</title>
<style>
  body { font-family: ui-sans-serif, system-ui; margin: 24px; max-width: 720px; }
  pre { background: #f4f4f0; padding: 12px; white-space: pre-wrap; }
  button { padding: 8px 14px; margin-right: 8px; }
</style>
</head>
<body>
  <h1>Intervention required</h1>
  <p>Automation paused on the <strong>same live session</strong>. Use the headed browser window, then hand control back.</p>
  <pre>${escapeHtml(JSON.stringify(req, null, 2))}</pre>
  <form method="post" action="/resume"><button type="submit">Resume automation</button></form>
  <form method="post" action="/abort" style="margin-top:8px"><button type="submit">Abort run</button></form>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] ?? ch);
}
