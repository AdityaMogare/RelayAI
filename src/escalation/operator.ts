import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import type { IncomingMessage } from "node:http";
import type { InterventionRequest, StepDisposition } from "../core/types.ts";
import type { InterventionHandle, ResumeDecision, ResumeWaiter } from "./control.ts";
import { auditLine, holderOf, sortQueue } from "./lifecycle.ts";

type Slot = {
  record: () => InterventionRequest;
  handle: InterventionHandle;
  resolve: (decision: ResumeDecision) => void;
  settled: boolean;
};

const slots = new Map<string, Slot>();
let server: http.Server | undefined;
let listenWait: Promise<number> | undefined;
let clients = 0;

export function createOperatorWaiter(opts: {
  port?: number;
  autoResumeMs?: number;
}): ResumeWaiter {
  return async (req, handle) => waitOnOperatorConsole(req, handle, opts);
}

export async function waitOnOperatorConsole(
  req: InterventionRequest,
  handle: InterventionHandle,
  opts: { port?: number; autoResumeMs?: number },
): Promise<ResumeDecision> {
  const port = opts.port ?? Number(process.env.RELAY_OPERATOR_PORT ?? 3847);
  const bound = await ensureServer(port);
  clients += 1;

  const decision = await new Promise<ResumeDecision>((resolve) => {
    const slot: Slot = {
      record: () => handle.record(),
      handle,
      settled: false,
      resolve: (d) => {
        if (slot.settled) return;
        slot.settled = true;
        resolve(d);
      },
    };
    slots.set(req.id, slot);

    const origin = `http://127.0.0.1:${bound}`;
    console.log(`\nOperator console: ${origin}`);
    console.log(
      `Session ${req.sessionId ?? "unknown"} — use the headed window already on ${req.url ?? "the paused page"}, not a new login.\n`,
    );

    if (opts.autoResumeMs && opts.autoResumeMs > 0) {
      setTimeout(() => {
        if (slot.settled) return;
        handle.claim("ci-bot", { operatorKind: "scripted" });
        handle.takeControl();
        slot.resolve({
          action: "resume",
          operatorId: "ci-bot",
          stepDisposition: "not_done",
          operatorKind: "scripted",
          note: `auto-resume after ${opts.autoResumeMs}ms`,
        });
      }, opts.autoResumeMs);
    }

    const onAbort = () => {
      slot.resolve({
        action: "abort",
        stepDisposition: "abort",
        note: "intervention TTL expired; session released without executing the risky step",
      });
    };
    if (handle.signal.aborted) onAbort();
    else handle.signal.addEventListener("abort", onAbort, { once: true });
  });

  slots.delete(req.id);
  clients -= 1;
  if (clients <= 0) await closeServer();
  return decision;
}

function queue(): InterventionRequest[] {
  return sortQueue([...slots.values()].map((s) => s.record()));
}

function ensureServer(port: number): Promise<number> {
  if (server) {
    const address = server.address();
    if (address && typeof address !== "string") return Promise.resolve(address.port);
  }
  if (listenWait) return listenWait;
  listenWait = new Promise((resolve, reject) => {
    const host = process.env.RELAY_BIND_HOST?.trim() || "127.0.0.1";
    server = http.createServer((incoming, res) => {
      void route(incoming, res);
    });
    server.listen(port, host, () => {
      const address = server?.address();
      if (!address || typeof address === "string") {
        reject(new Error("operator console failed to bind"));
        return;
      }
      resolve(address.port);
    });
    server.on("error", reject);
  });
  return listenWait;
}

async function closeServer(): Promise<void> {
  const current = server;
  server = undefined;
  listenWait = undefined;
  if (!current) return;
  await new Promise<void>((resolve) => current.close(() => resolve()));
}

async function route(incoming: IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(incoming.url ?? "/", "http://127.0.0.1");
  if (incoming.method === "GET" && url.pathname === "/shot") {
    const id = url.searchParams.get("id") ?? "";
    const path = slots.get(id)?.record().screenshotPath;
    if (!path || !existsSync(path)) {
      res.writeHead(404);
      res.end("no screenshot");
      return;
    }
    res.writeHead(200, { "content-type": "image/png" });
    res.end(readFileSync(path));
    return;
  }

  if (incoming.method === "POST" && url.pathname === "/claim") {
    const params = await readForm(incoming);
    const id = params.get("id") ?? "";
    const operatorId = (params.get("operatorId") ?? "").trim();
    const slot = slots.get(id);
    if (!slot || !operatorId) {
      html(res, 400, "<p>Claim requires an intervention id and operator id.</p>");
      return;
    }
    const holder = holderOf(queue());
    if (holder && holder.id !== id) {
      html(
        res,
        409,
        `<p>operator ${escapeHtml(holder.operatorId ?? "")} already holds ${escapeHtml(holder.id)}. Return that session first.</p><p><a href="/">Queue</a></p>`,
      );
      return;
    }
    slot.handle.claim(operatorId, { operatorKind: "human" });
    slot.handle.takeControl();
    html(res, 200, operatorHtml(slot.record(), queue()));
    return;
  }

  if (incoming.method === "POST" && url.pathname === "/return") {
    const params = await readForm(incoming);
    const id = params.get("id") ?? "";
    const slot = slots.get(id);
    const disposition = parseDisposition(params.get("disposition"));
    const operatorId = (params.get("operatorId") ?? slot?.record().operatorId ?? "").trim();
    if (!slot || !disposition) {
      html(res, 400, "<p>Return requires a step disposition.</p>");
      return;
    }
    if (slot.record().state === "raised") {
      slot.handle.claim(operatorId || "unknown", { operatorKind: "human" });
      slot.handle.takeControl();
    }
    if (disposition === "abort") {
      slot.resolve({
        action: "abort",
        operatorId,
        stepDisposition: "abort",
        operatorKind: "human",
        note: `${operatorId} aborted the run`,
      });
      html(res, 200, "<p>Run aborted. The teller session was released.</p>");
      return;
    }
    slot.resolve({
      action: "resume",
      operatorId,
      stepDisposition: disposition,
      operatorKind: "human",
      note:
        disposition === "completed_by_human"
          ? `${operatorId} marked completed_by_human`
          : `${operatorId} marked not_done`,
    });
    html(
      res,
      200,
      disposition === "completed_by_human"
        ? "<p>Noted — automation will re-observe and skip this step if the checkpoint already holds.</p>"
        : "<p>Control returned to automation. You can close this tab.</p>",
    );
    return;
  }

  html(res, 200, operatorHtml(pickRecord(url.searchParams.get("id")), queue()));
}

function pickRecord(id: string | null): InterventionRequest {
  if (id && slots.has(id)) return slots.get(id)!.record();
  const ordered = queue();
  return ordered[0] ?? emptyRecord();
}

function emptyRecord(): InterventionRequest {
  return {
    id: "none",
    createdAt: new Date().toISOString(),
    reason: "No intervention is waiting.",
    state: "raised",
  };
}

function parseDisposition(value: string | null): StepDisposition | undefined {
  if (value === "completed_by_human" || value === "not_done" || value === "abort") return value;
  return undefined;
}

export function operatorHtml(req: InterventionRequest, queued: InterventionRequest[] = []): string {
  const others = sortQueue(queued.filter((item) => item.id !== req.id));
  const queueBlock =
    others.length > 0
      ? `<h2>Queue</h2>
        <p>One operator may hold one live session. Unclaimed items stay <code>raised</code> until claimed or the TTL fires.</p>
        <ol>${others
          .map(
            (item) =>
              `<li><a href="/?id=${encodeURIComponent(item.id)}">${escapeHtml(item.capabilityId ?? item.id)}</a>
              step ${escapeHtml(item.stepId ?? "?")} · priority ${item.queuePriority ?? "—"} · ${escapeHtml(item.state ?? "raised")}</li>`,
          )
          .join("")}</ol>`
      : "";
  const checkpoint = req.checkpointExpect
    ? `<p>Post-condition for this step: <code>${escapeHtml(req.checkpointExpect)}</code>. If you already did the work, the live window should already match it.</p>`
    : "";
  const entry = req.entryCheckpoint
    ? `<p>Entry checkpoint (re-verified after you return): <code>${escapeHtml(`${req.entryCheckpoint.kind} ${req.entryCheckpoint.expect}`)}</code></p>`
    : "";
  const shot =
    req.screenshotPath && req.id !== "none"
      ? `<p><img alt="Paused teller session" src="/shot?id=${encodeURIComponent(req.id)}" style="max-width:100%;border:1px solid #ccc"></p>`
      : "";
  const expires = req.expiresAt ? `<p>TTL expires at <code>${escapeHtml(req.expiresAt)}</code>. Unattended → abandoned, session released, risky step not executed.</p>` : "";
  const operator = req.operatorId ?? process.env.RELAY_OPERATOR_ID ?? "teller01";
  const claimed = req.state === "claimed" || req.state === "in_control";
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>RelayAI Operator</title>
<style>
  body { font-family: ui-sans-serif, system-ui; margin: 24px; max-width: 760px; }
  pre { background: #f4f4f0; padding: 12px; white-space: pre-wrap; }
  button { padding: 8px 14px; margin-right: 8px; }
  .row { margin-top: 12px; }
  label { display: block; margin: 6px 0; }
  .session { background: #7a1f1f; color: #fff; padding: 10px 12px; }
</style>
</head>
<body>
  <h1>Intervention ${escapeHtml(req.state ?? "raised")}</h1>
  <p class="session">Live Playwright session <code>${escapeHtml(req.sessionId ?? "unknown")}</code>. This console does not open a bank login. Use the headed Chromium window already at <code>${escapeHtml(req.url ?? "")}</code>.</p>
  ${shot}
  ${checkpoint}
  ${entry}
  ${expires}
  <p>${escapeHtml(auditLine(req))}</p>
  ${queueBlock}
  <pre>${escapeHtml(JSON.stringify(req, null, 2))}</pre>
  ${
    claimed
      ? `<form method="post" action="/return">
          <input type="hidden" name="id" value="${escapeHtml(req.id)}">
          <input type="hidden" name="operatorId" value="${escapeHtml(operator)}">
          <p>Did you complete this step?</p>
          <label><input type="radio" name="disposition" value="completed_by_human" required> completed_by_human — skip (I already did it)</label>
          <label><input type="radio" name="disposition" value="not_done"> not_done — execute once</label>
          <label><input type="radio" name="disposition" value="abort"> abort — release the session</label>
          <div class="row"><button type="submit">Return control</button></div>
        </form>`
      : `<form method="post" action="/claim">
          <input type="hidden" name="id" value="${escapeHtml(req.id)}">
          <div class="row">
            <label>Operator id <input name="operatorId" value="${escapeHtml(operator)}" required></label>
          </div>
          <button type="submit">Claim this session</button>
        </form>`
  }
</body>
</html>`;
}

function html(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
}

function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  return readBody(req).then((body) => new URLSearchParams(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] ?? ch);
}
