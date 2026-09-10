import http from "node:http";
import { URL } from "node:url";
import { listDisputes, lookupDispute, lookupMember } from "./data.ts";
import {
  deniedPage,
  disputeDetailPage,
  disputeDone,
  disputeFileForm,
  disputeListPage,
  disputeNotFoundPage,
  disputeReview,
  expiredPage,
  memberPage,
  notFoundPage,
  searchPage,
  subAccountDone,
  subAccountForm,
  subAccountReview,
  tickerPage,
} from "./html.ts";

export type ConsoleServer = {
  port: number;
  origin: string;
  close: () => Promise<void>;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function send(res: http.ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(html);
}

export function createConsoleServer(): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const notice = url.searchParams.get("notice") === "1";

    if (url.searchParams.get("expired") === "1") {
      send(res, 200, expiredPage());
      return;
    }
    if (url.searchParams.get("slow") === "1") {
      await sleep(2500);
    }

    if (url.pathname === "/ticker") {
      send(res, 200, tickerPage());
      return;
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      send(res, 200, searchPage({ notice }));
      return;
    }

    if (url.pathname === "/search") {
      const mid = (url.searchParams.get("mid") ?? "").trim();
      if (!mid) {
        send(res, 200, searchPage({ notice, error: "Member ID is required." }));
        return;
      }
      const member = lookupMember(mid);
      if (!member) {
        send(res, 200, notFoundPage(mid));
        return;
      }
      if (member.status === "restricted") {
        send(res, 200, deniedPage(mid));
        return;
      }
      res.writeHead(302, { location: `/member/${member.id}` });
      res.end();
      return;
    }

    const memberMatch = url.pathname.match(/^\/member\/([^/]+)$/);
    if (memberMatch) {
      const member = lookupMember(memberMatch[1] ?? "");
      if (!member) {
        send(res, 200, notFoundPage(memberMatch[1] ?? ""));
        return;
      }
      if (member.status === "restricted") {
        send(res, 200, deniedPage(member.id));
        return;
      }
      send(res, 200, memberPage(member));
      return;
    }

    const formMatch = url.pathname.match(/^\/member\/([^/]+)\/sub-account$/);
    if (formMatch) {
      const memberId = formMatch[1] ?? "";
      const member = lookupMember(memberId);
      if (!member || member.status === "restricted") {
        send(res, 200, member ? deniedPage(memberId) : notFoundPage(memberId));
        return;
      }
      const step = url.searchParams.get("step");
      const product = (url.searchParams.get("product") ?? "").trim();
      if (step === "review") {
        if (!product) {
          send(res, 200, subAccountForm(memberId, "Select a product to continue."));
          return;
        }
        send(res, 200, subAccountReview(memberId, product));
        return;
      }
      send(res, 200, subAccountForm(memberId));
      return;
    }

    const confirmMatch = url.pathname.match(/^\/member\/([^/]+)\/sub-account\/confirm$/);
    if (confirmMatch) {
      const memberId = confirmMatch[1] ?? "";
      const product = (url.searchParams.get("product") ?? "Share Savings").trim();
      send(res, 200, subAccountDone(memberId, product));
      return;
    }

    const disputesListMatch = url.pathname.match(/^\/member\/([^/]+)\/disputes\/?$/);
    if (disputesListMatch) {
      const memberId = disputesListMatch[1] ?? "";
      const member = lookupMember(memberId);
      if (!member) {
        send(res, 200, notFoundPage(memberId));
        return;
      }
      if (member.status === "restricted") {
        send(res, 200, deniedPage(memberId));
        return;
      }
      send(
        res,
        200,
        disputeListPage(
          memberId,
          listDisputes(memberId).map((d) => ({
            id: d.id,
            merchant: d.merchant,
            amount: d.amount,
            status: d.status === "filed" ? "Filed" : "Open",
          })),
        ),
      );
      return;
    }

    const disputesOpenMatch = url.pathname.match(/^\/member\/([^/]+)\/disputes\/open$/);
    if (disputesOpenMatch) {
      const memberId = disputesOpenMatch[1] ?? "";
      const member = lookupMember(memberId);
      if (!member) {
        send(res, 200, notFoundPage(memberId));
        return;
      }
      if (member.status === "restricted") {
        send(res, 200, deniedPage(memberId));
        return;
      }
      const did = (url.searchParams.get("did") ?? "").trim();
      if (!did) {
        send(
          res,
          200,
          disputeListPage(
            memberId,
            listDisputes(memberId).map((d) => ({
              id: d.id,
              merchant: d.merchant,
              amount: d.amount,
              status: d.status === "filed" ? "Filed" : "Open",
            })),
            "Dispute ID is required.",
          ),
        );
        return;
      }
      res.writeHead(302, { location: `/member/${memberId}/disputes/${encodeURIComponent(did.toUpperCase())}` });
      res.end();
      return;
    }

    const disputesSubmitMatch = url.pathname.match(/^\/member\/([^/]+)\/disputes\/([^/]+)\/submit$/);
    if (disputesSubmitMatch) {
      const memberId = disputesSubmitMatch[1] ?? "";
      const disputeId = decodeURIComponent(disputesSubmitMatch[2] ?? "");
      const reason = (url.searchParams.get("reason") ?? "Unauthorized").trim();
      send(res, 200, disputeDone(memberId, disputeId, reason));
      return;
    }

    const disputesFileMatch = url.pathname.match(/^\/member\/([^/]+)\/disputes\/([^/]+)\/file$/);
    if (disputesFileMatch) {
      const memberId = disputesFileMatch[1] ?? "";
      const disputeId = decodeURIComponent(disputesFileMatch[2] ?? "");
      const member = lookupMember(memberId);
      if (!member) {
        send(res, 200, notFoundPage(memberId));
        return;
      }
      if (member.status === "restricted") {
        send(res, 200, deniedPage(memberId));
        return;
      }
      const dispute = lookupDispute(memberId, disputeId);
      if (!dispute) {
        send(res, 200, disputeNotFoundPage(memberId, disputeId));
        return;
      }
      if (dispute.status === "filed") {
        send(res, 200, disputeDetailPage(dispute));
        return;
      }
      const step = url.searchParams.get("step");
      const reason = (url.searchParams.get("reason") ?? "").trim();
      if (step === "review") {
        if (!reason) {
          send(res, 200, disputeFileForm(memberId, dispute.id, "Reason is required."));
          return;
        }
        send(res, 200, disputeReview(memberId, dispute.id, reason, dispute.amount));
        return;
      }
      send(res, 200, disputeFileForm(memberId, dispute.id));
      return;
    }

    const disputesDetailMatch = url.pathname.match(/^\/member\/([^/]+)\/disputes\/([^/]+)$/);
    if (disputesDetailMatch) {
      const memberId = disputesDetailMatch[1] ?? "";
      const disputeId = decodeURIComponent(disputesDetailMatch[2] ?? "");
      const member = lookupMember(memberId);
      if (!member) {
        send(res, 200, notFoundPage(memberId));
        return;
      }
      if (member.status === "restricted") {
        send(res, 200, deniedPage(memberId));
        return;
      }
      const dispute = lookupDispute(memberId, disputeId);
      if (!dispute) {
        send(res, 200, disputeNotFoundPage(memberId, disputeId));
        return;
      }
      send(res, 200, disputeDetailPage(dispute));
      return;
    }

    send(res, 404, searchPage({ error: "Screen not found." }));
  });
}

export async function startConsole(port = 0): Promise<ConsoleServer> {
  const server = createConsoleServer();
  await new Promise<void>((resolve, reject) => {
    server.listen(port, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("console failed to bind");
  }
  return {
    port: address.port,
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("server.ts")) {
  const port = Number(process.env.RELAY_CONSOLE_PORT ?? 3000);
  const started = await startConsole(port);
  console.log(`Relay Credit Union console: ${started.origin}`);
}
