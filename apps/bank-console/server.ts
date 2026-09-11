import http from "node:http";
import { URL } from "node:url";
import type { Card, Dispute } from "./data.ts";
import {
  CARD_PAGE_SIZE,
  DISPUTE_PAGE_SIZE,
  SEARCH_PAGE_SIZE,
  cloneCards,
  cloneDisputes,
  listCards,
  listDisputes,
  lookupCard,
  lookupDispute,
  lookupMember,
  markCardBlocked,
  markCardReissued,
  markDisputeFiled,
  paginate,
  productsForTier,
  resetCards,
  resetDisputes,
  searchMembers,
  searchMembersByLastName,
} from "./data.ts";
import { DuplicateFilingError } from "../../src/core/errors.ts";
import { CardActionsStore, DuplicateCardActionError } from "./card-actions.ts";
import { FilingsStore } from "./filings.ts";
import { FormTokenStore } from "./tokens.ts";
import {
  cardBlockConfirm,
  cardBusinessPage,
  cardDetailPage,
  cardDone,
  cardListPage,
  cardNotFoundPage,
  cardReissueConfirm,
  deniedPage,
  disputeDetailPage,
  disputeDone,
  disputeFileForm,
  disputeListPage,
  disputeNotFoundPage,
  disputeReview,
  expiredPage,
  framesetBanner,
  framesetIndex,
  framesetNav,
  framesetWork,
  invalidTokenPage,
  loginPage,
  memberPage,
  memberResultsPage,
  methodNotAllowedPage,
  notFoundPage,
  runWithSkin,
  searchPage,
  subAccountDone,
  subAccountForm,
  subAccountReview,
  tickerPage,
  unavailablePage,
  wrongScreenPage,
  adminWirePage,
} from "./html.ts";
import {
  framesetPage,
  navFrame,
  workCardBlock,
  workCardBusiness,
  workCardDetail,
  workCardDone,
  workCardList,
  workCardReissue,
  workMember,
  workMemberResults,
  workSearch,
} from "./legacy.ts";
import { RELAY_SKIN, skinById, type ConsoleSkin } from "./skins.ts";
import {
  DEMO_TELLER,
  SESSION_COOKIE,
  TENANT_COOKIE,
  UI_COOKIE,
  authenticate,
  clearCookieHeader,
  cookieHeader,
  parseCookie,
  SessionStore,
  type TellerUser,
} from "./session.ts";

export { FilingsStore } from "./filings.ts";
export { CardActionsStore } from "./card-actions.ts";

export type ConsoleOptions = {
  skin?: ConsoleSkin;
  auth?: boolean;
  users?: TellerUser[];
  sessionTtlMs?: number;
};

export type ConsoleServer = {
  port: number;
  origin: string;
  close: () => Promise<void>;
  filings: FilingsStore;
  tokens: FormTokenStore;
  cardActions: CardActionsStore;
  skin: ConsoleSkin;
  reset: () => void;
};

function isSkin(value: ConsoleSkin | ConsoleOptions): value is ConsoleSkin {
  return "labels" in value && "banner" in value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendCookie(res: http.ServerResponse, cookie: string): void {
  const prev = res.getHeader("set-cookie");
  const list = Array.isArray(prev) ? [...prev.map(String)] : prev ? [String(prev)] : [];
  list.push(cookie);
  res.setHeader("set-cookie", list);
}

function send(res: http.ServerResponse, status: number, html: string): void {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.writeHead(status);
  res.end(html);
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function redirect(res: http.ServerResponse, location: string): void {
  res.setHeader("location", location);
  res.writeHead(302);
  res.end();
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(`${JSON.stringify(body, null, 2)}\n`);
}

function disputeRows(memberId: string, rows: Dispute[]) {
  return listDisputes(memberId, rows).map((d) => ({
    id: d.id,
    merchant: d.merchant,
    amount: d.amount,
    last4: d.last4,
    posted: d.posted,
    status: d.status === "filed" ? "Filed" : "Open",
  }));
}

function cardRows(memberId: string, rows: Card[]) {
  return listCards(memberId, rows).map((c) => ({
    last4: c.last4,
    product: c.product,
    status: c.status === "blocked" ? "Blocked" : "Active",
    account: c.accountKind === "business" ? "Business" : "Personal",
  }));
}

export function createConsoleServer(
  filings = new FilingsStore(),
  skinOrOpts: ConsoleSkin | ConsoleOptions = RELAY_SKIN,
  tokens = new FormTokenStore(),
  disputes = cloneDisputes(),
  cards = cloneCards(),
  cardActions = new CardActionsStore(),
): http.Server {
  const options: ConsoleOptions = isSkin(skinOrOpts) ? { skin: skinOrOpts } : skinOrOpts;
  const defaultSkin = options.skin ?? RELAY_SKIN;
  const sessions = new SessionStore(options.sessionTtlMs);
  const users = options.users ?? [{ username: DEMO_TELLER.username, secret: DEMO_TELLER.secret }];
  const requireAuth = Boolean(options.auth);
  let flakyHits = 0;
  let pendingMemberId = "";
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const tenant = url.searchParams.get("tenant") ?? parseCookie(req.headers.cookie, TENANT_COOKIE);
    const skin = tenant ? skinById(tenant) : defaultSkin;
    if (url.searchParams.get("tenant")) {
      appendCookie(res, cookieHeader(TENANT_COOKIE, url.searchParams.get("tenant")!, 86_400));
    }
    runWithSkin(skin, () => {
      void handleRequest(req, res, {
        filings,
        tokens,
        disputes,
        cards,
        cardActions,
        skin,
        getFlaky: () => flakyHits,
        setFlaky: (n) => {
          flakyHits = n;
        },
        sessions,
        users,
        requireAuth,
        getPending: () => pendingMemberId,
        setPending: (id: string) => {
          pendingMemberId = id;
        },
      });
    });
  });
}

type RequestCtx = {
  filings: FilingsStore;
  tokens: FormTokenStore;
  disputes: Dispute[];
  cards: Card[];
  cardActions: CardActionsStore;
  skin: ConsoleSkin;
  getFlaky: () => number;
  setFlaky: (n: number) => void;
  sessions: SessionStore;
  users: TellerUser[];
  requireAuth: boolean;
  getPending: () => string;
  setPending: (id: string) => void;
};

function publicPath(pathname: string): boolean {
  return (
    pathname === "/login" ||
    pathname === "/ticker" ||
    pathname === "/legacy" ||
    pathname.startsWith("/legacy/") ||
    pathname === "/frames" ||
    pathname.startsWith("/frames/") ||
    pathname === "/debug/filings" ||
    pathname === "/debug/card-actions" ||
    pathname === "/debug/sql"
  );
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse, ctx: RequestCtx): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const noticeParam = url.searchParams.get("notice");
    const notice = noticeParam === "always" ? ("always" as const) : noticeParam === "1";
    const cookies = String(req.headers.cookie ?? "");
    if (url.searchParams.get("attest") === "1") {
      appendCookie(res, "relay_attest=1; Path=/");
    } else if (url.searchParams.get("attest") === "0") {
      appendCookie(res, "relay_attest=; Path=/; Max-Age=0");
    }
    const attest =
      url.searchParams.get("attest") === "1" ||
      (url.searchParams.get("attest") !== "0" && /(?:^|;\s*)relay_attest=1/.test(cookies));

    if (url.searchParams.get("branch") === "0") {
      appendCookie(res, "relay_branch=0; Path=/");
    }
    const branchDismissed =
      url.searchParams.get("branch") === "0" || /(?:^|;\s*)relay_branch=0/.test(cookies);
    const branchOpen = Boolean(ctx.skin.extraInterstitial) && !branchDismissed;

    const legacyOn = url.searchParams.get("legacy") === "1" || parseCookie(req.headers.cookie, UI_COOKIE) === "legacy";
    if (url.searchParams.get("legacy") === "1") {
      appendCookie(res, cookieHeader(UI_COOKIE, "legacy", 86_400));
    }

    if (url.pathname === "/debug/filings") {
      sendJson(res, 200, { filings: ctx.filings.all(), subAccounts: ctx.filings.subAccounts() });
      return;
    }
    if (url.pathname === "/debug/card-actions") {
      sendJson(res, 200, { cardActions: ctx.cardActions.all() });
      return;
    }
    if (url.pathname === "/debug/sql") {
      const sql = url.searchParams.get("q") ?? "";
      try {
        sendJson(res, 200, ctx.filings.exec(sql));
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    if (url.pathname === "/login" && req.method === "GET") {
      send(res, 200, loginPage({ next: url.searchParams.get("next") ?? "/" }));
      return;
    }
    if (url.pathname === "/login" && req.method === "POST") {
      const body = new URLSearchParams(await readBody(req));
      const username = (body.get("username") ?? "").trim();
      const secret = body.get("password") ?? "";
      const pending = ctx.getPending();
      const next = pending || body.get("next") || "/";
      if (ctx.requireAuth || username || secret) {
        if (!authenticate(ctx.users, username, secret)) {
          send(res, 200, loginPage({ error: "Invalid teller credentials.", next }));
          return;
        }
        const expireAfterRaw = url.searchParams.get("expire-after") ?? body.get("expire-after");
        const expireAfter = expireAfterRaw ? Number(expireAfterRaw) : undefined;
        const session = ctx.sessions.create(username, Number.isFinite(expireAfter) ? expireAfter : undefined);
        appendCookie(res, cookieHeader(SESSION_COOKIE, session.id, 90));
      }
      ctx.setPending("");
      redirect(res, next.startsWith("/") ? next : "/");
      return;
    }
    if (url.pathname === "/logout") {
      const sid = parseCookie(req.headers.cookie, SESSION_COOKIE);
      if (sid) ctx.sessions.destroy(sid);
      appendCookie(res, clearCookieHeader(SESSION_COOKIE));
      redirect(res, "/login");
      return;
    }

    if (url.searchParams.get("expired") === "1") {
      send(res, 200, expiredPage());
      return;
    }
    if (url.searchParams.get("wrong") === "1") {
      send(res, 200, wrongScreenPage());
      return;
    }
    if (url.searchParams.get("flaky") === "1") {
      const flakyHits = ctx.getFlaky() + 1;
      ctx.setFlaky(flakyHits);
      if (flakyHits <= 2) {
        send(res, 503, unavailablePage());
        return;
      }
    }
    if (url.searchParams.get("unavailable") === "1") {
      send(res, 503, unavailablePage());
      return;
    }
    if (url.searchParams.get("slow") === "1") {
      await sleep(2500);
    }

    if (ctx.requireAuth && !publicPath(url.pathname)) {
      let session = ctx.sessions.get(parseCookie(req.headers.cookie, SESSION_COOKIE));
      const expireAfterRaw = url.searchParams.get("expire-after");
      if (session && expireAfterRaw) ctx.sessions.setExpireAfter(session, Number(expireAfterRaw));
      if (session) session = ctx.sessions.hit(session);
      if (!session) {
        if (parseCookie(req.headers.cookie, SESSION_COOKIE)) {
          send(res, 200, expiredPage());
          return;
        }
        send(res, 200, loginPage({ next: `${url.pathname}${url.search}` }));
        return;
      }
    }

    if (url.pathname === "/ticker") {
      send(res, 200, tickerPage());
      return;
    }

    if (url.pathname === "/legacy" || url.pathname === "/legacy/") {
      send(res, 200, framesetIndex());
      return;
    }
    if (url.pathname === "/legacy/banner") {
      send(res, 200, framesetBanner());
      return;
    }
    if (url.pathname === "/legacy/nav") {
      send(res, 200, framesetNav());
      return;
    }
    if (url.pathname === "/legacy/work") {
      send(res, 200, framesetWork());
      return;
    }

    if (url.pathname === "/frames/nav") {
      send(res, 200, navFrame());
      return;
    }
    if (url.pathname === "/frames/work") {
      const screen = url.searchParams.get("screen") ?? "search";
      const mid = (url.searchParams.get("mid") ?? "").trim();
      const last = (url.searchParams.get("last") ?? "").trim();
      if (screen === "member" && mid) {
        const member = lookupMember(mid);
        if (!member) {
          send(res, 200, workSearch({ error: `Member not found` }));
          return;
        }
        if (member.status === "restricted") {
          send(res, 200, deniedPage(member.id));
          return;
        }
        send(res, 200, workMember(member));
        return;
      }
      if (last && !mid) {
        const found = searchMembersByLastName(last);
        const page = paginate(found, Number(url.searchParams.get("page") ?? 1), SEARCH_PAGE_SIZE);
        send(res, 200, workMemberResults(last, page));
        return;
      }
      if (mid) {
        const exact = lookupMember(mid);
        if (exact) {
          if (exact.status === "restricted") {
            send(res, 200, deniedPage(exact.id));
            return;
          }
          send(res, 200, workMember(exact));
          return;
        }
        const found = searchMembers(mid);
        if (found.length === 0) {
          send(res, 200, workSearch({ error: "Member not found" }));
          return;
        }
        if (found.length > 1) {
          const page = paginate(found, Number(url.searchParams.get("page") ?? 1), SEARCH_PAGE_SIZE);
          send(res, 200, workMemberResults(mid, page));
          return;
        }
        const member = found[0]!;
        if (member.status === "restricted") {
          send(res, 200, deniedPage(member.id));
          return;
        }
        send(res, 200, workMember(member));
        return;
      }
      send(res, 200, workSearch({ notice }));
      return;
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      if (legacyOn) {
        send(res, 200, framesetPage("/frames/work?screen=search"));
        return;
      }
      send(res, 200, searchPage({ notice, expireMid: url.searchParams.get("expireMid") === "1", branchOpen }));
      return;
    }

    if (url.pathname === "/search") {
      const mid = (url.searchParams.get("mid") ?? "").trim();
      const last = (url.searchParams.get("last") ?? "").trim();
      if (url.searchParams.get("expireMid") === "1" && (mid || last)) {
        const pending =
          lookupMember(mid)?.id ?? (last ? searchMembersByLastName(last)[0]?.id : undefined) ?? mid;
        ctx.setPending(pending);
        send(res, 200, expiredPage());
        return;
      }
      if (last && !mid) {
        const found = searchMembersByLastName(last);
        if (found.length === 0) {
          send(res, 200, notFoundPage(last));
          return;
        }
        const page = paginate(found, Number(url.searchParams.get("page") ?? 1), SEARCH_PAGE_SIZE);
        send(res, 200, memberResultsPage(last, page));
        return;
      }
      if (!mid) {
        send(res, 200, searchPage({ notice, error: "Member ID is required.", branchOpen }));
        return;
      }
      const exact = lookupMember(mid);
      if (exact) {
        if (exact.status === "restricted") {
          send(res, 200, deniedPage(mid));
          return;
        }
        redirect(res, `/member/${exact.id}`);
        return;
      }
      const found = searchMembers(mid);
      if (found.length === 0) {
        send(res, 200, notFoundPage(mid));
        return;
      }
      if (found.length > 1) {
        const page = paginate(found, Number(url.searchParams.get("page") ?? 1), SEARCH_PAGE_SIZE);
        send(res, 200, memberResultsPage(mid, { ...page, total: found.length }));
        return;
      }
      const member = found[0]!;
      if (member.status === "restricted") {
        send(res, 200, deniedPage(member.id));
        return;
      }
      redirect(res, `/member/${member.id}`);
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
      send(res, 200, legacyOn ? workMember(member) : memberPage(member));
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
      const products = productsForTier(member.tier);
      if (step === "review") {
        if (!product) {
          send(res, 200, subAccountForm(memberId, "Select a product to continue.", products));
          return;
        }
        send(res, 200, subAccountReview(memberId, product, ctx.tokens.issue(`sub-account:${memberId}`)));
        return;
      }
      send(res, 200, subAccountForm(memberId, undefined, products));
      return;
    }

    const confirmMatch = url.pathname.match(/^\/member\/([^/]+)\/sub-account\/confirm$/);
    if (confirmMatch) {
      const memberId = confirmMatch[1] ?? "";
      if (req.method !== "POST") {
        send(res, 405, methodNotAllowedPage(req.method ?? "GET", url.pathname));
        return;
      }
      const body = new URLSearchParams(await readBody(req));
      const product = (body.get("product") ?? url.searchParams.get("product") ?? "Share Savings").trim();
      if (!ctx.tokens.consume(body.get("csrf") ?? undefined, `sub-account:${memberId}`)) {
        send(res, 400, invalidTokenPage());
        return;
      }
      ctx.filings.insertSubAccount({ member_id: memberId, product });
      redirect(res, `/member/${memberId}/sub-account/opened?product=${encodeURIComponent(product)}`);
      return;
    }

    const openedMatch = url.pathname.match(/^\/member\/([^/]+)\/sub-account\/opened$/);
    if (openedMatch) {
      const memberId = openedMatch[1] ?? "";
      const product = (url.searchParams.get("product") ?? "Share Savings").trim() || "Share Savings";
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
      const all = disputeRows(memberId, ctx.disputes);
      const page = paginate(all, Number(url.searchParams.get("page") ?? 1), DISPUTE_PAGE_SIZE);
      send(
        res,
        200,
        disputeListPage(memberId, page.rows, undefined, { attest, page: page.page, pages: page.pages }),
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
        send(res, 200, disputeListPage(memberId, disputeRows(memberId, ctx.disputes), "Dispute ID is required."));
        return;
      }
      redirect(res, `/member/${memberId}/disputes/${encodeURIComponent(did.toUpperCase())}`);
      return;
    }

    const disputesSubmitMatch = url.pathname.match(/^\/member\/([^/]+)\/disputes\/([^/]+)\/submit$/);
    if (disputesSubmitMatch) {
      const memberId = disputesSubmitMatch[1] ?? "";
      const disputeId = decodeURIComponent(disputesSubmitMatch[2] ?? "");
      if (req.method !== "POST") {
        send(res, 405, methodNotAllowedPage(req.method ?? "GET", url.pathname));
        return;
      }
      const body = new URLSearchParams(await readBody(req));
      const reason = (body.get("reason") ?? "Unauthorized").trim();
      if (!ctx.tokens.consume(body.get("csrf") ?? undefined, `dispute:${memberId}:${disputeId}`)) {
        send(res, 400, invalidTokenPage());
        return;
      }
      try {
        ctx.filings.insert({ dispute_id: disputeId, member_id: memberId, reason });
      } catch (err) {
        if (err instanceof DuplicateFilingError) {
          const existing = lookupDispute(memberId, disputeId, ctx.disputes) ?? {
            id: disputeId,
            memberId,
            merchant: "",
            amount: "",
            posted: "",
            last4: "",
            status: "filed" as const,
            caseNumber: "CASE-77201",
          };
          markDisputeFiled(disputeId, "CASE-77201", ctx.disputes);
          send(res, 200, disputeDetailPage({ ...existing, status: "filed", caseNumber: existing.caseNumber ?? "CASE-77201" }));
          return;
        }
        throw err;
      }
      markDisputeFiled(disputeId, "CASE-77201", ctx.disputes);
      redirect(res, `/member/${memberId}/disputes/${encodeURIComponent(disputeId)}/receipt`);
      return;
    }

    const disputesReceiptMatch = url.pathname.match(/^\/member\/([^/]+)\/disputes\/([^/]+)\/receipt$/);
    if (disputesReceiptMatch) {
      const memberId = disputesReceiptMatch[1] ?? "";
      const disputeId = decodeURIComponent(disputesReceiptMatch[2] ?? "");
      send(res, 200, disputeDone(memberId, disputeId, "Unauthorized"));
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
      const dispute = lookupDispute(memberId, disputeId, ctx.disputes);
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
        send(res, 200, disputeReview(memberId, dispute.id, reason, dispute.amount, ctx.tokens.issue(`dispute:${memberId}:${dispute.id}`)));
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
      const dispute = lookupDispute(memberId, disputeId, ctx.disputes);
      if (!dispute) {
        send(res, 200, disputeNotFoundPage(memberId, disputeId));
        return;
      }
      send(res, 200, disputeDetailPage(dispute));
      return;
    }

    const cardsListMatch = url.pathname.match(/^\/member\/([^/]+)\/cards\/?$/);
    if (cardsListMatch) {
      const memberId = cardsListMatch[1] ?? "";
      const member = lookupMember(memberId);
      if (!member) {
        send(res, 200, notFoundPage(memberId));
        return;
      }
      if (member.status === "restricted") {
        send(res, 200, deniedPage(memberId));
        return;
      }
      const all = cardRows(memberId, ctx.cards);
      const page = paginate(all, Number(url.searchParams.get("page") ?? 1), CARD_PAGE_SIZE);
      send(
        res,
        200,
        legacyOn
          ? workCardList(memberId, page.rows)
          : cardListPage(memberId, page.rows, undefined, { page: page.page, pages: page.pages }),
      );
      return;
    }

    const cardsOpenMatch = url.pathname.match(/^\/member\/([^/]+)\/cards\/open$/);
    if (cardsOpenMatch) {
      const memberId = cardsOpenMatch[1] ?? "";
      const member = lookupMember(memberId);
      if (!member) {
        send(res, 200, notFoundPage(memberId));
        return;
      }
      if (member.status === "restricted") {
        send(res, 200, deniedPage(memberId));
        return;
      }
      const last4 = (url.searchParams.get("last4") ?? "").trim();
      if (!last4) {
        const html = legacyOn
          ? workCardList(memberId, cardRows(memberId, ctx.cards), "Card last 4 is required.")
          : cardListPage(memberId, cardRows(memberId, ctx.cards), "Card last 4 is required.");
        send(res, 200, html);
        return;
      }
      redirect(res, `/member/${memberId}/cards/${encodeURIComponent(last4)}`);
      return;
    }

    const cardsBlockMatch = url.pathname.match(/^\/member\/([^/]+)\/cards\/([^/]+)\/block$/);
    if (cardsBlockMatch) {
      const memberId = cardsBlockMatch[1] ?? "";
      const last4 = decodeURIComponent(cardsBlockMatch[2] ?? "");
      const member = lookupMember(memberId);
      if (!member) {
        send(res, 200, notFoundPage(memberId));
        return;
      }
      if (member.status === "restricted") {
        send(res, 200, deniedPage(memberId));
        return;
      }
      const card = lookupCard(memberId, last4, ctx.cards);
      if (!card) {
        send(res, 200, cardNotFoundPage(memberId, last4));
        return;
      }
      if (req.method === "POST") {
        const body = new URLSearchParams(await readBody(req));
        if (!ctx.tokens.consume(body.get("csrf") ?? undefined, `block:${memberId}:${card.last4}`)) {
          send(res, 400, invalidTokenPage());
          return;
        }
        if (card.accountKind === "business") {
          send(res, 200, legacyOn ? workCardBusiness(memberId, card.last4) : cardBusinessPage(memberId, card.last4));
          return;
        }
        if (card.status === "blocked") {
          send(res, 200, legacyOn ? workCardDetail(card) : cardDetailPage(card));
          return;
        }
        markCardBlocked(memberId, card.last4, ctx.cards);
        redirect(res, `/member/${memberId}/cards/${encodeURIComponent(card.last4)}/reissue`);
        return;
      }
      if (req.method !== "GET") {
        send(res, 405, methodNotAllowedPage(req.method ?? "GET", url.pathname));
        return;
      }
      if (card.accountKind === "business") {
        send(res, 200, legacyOn ? workCardBusiness(memberId, card.last4) : cardBusinessPage(memberId, card.last4));
        return;
      }
      if (card.status === "blocked") {
        send(res, 200, legacyOn ? workCardDetail(card) : cardDetailPage(card));
        return;
      }
      const csrf = ctx.tokens.issue(`block:${memberId}:${card.last4}`);
      send(
        res,
        200,
        legacyOn
          ? workCardBlock(memberId, card.last4, card.product, csrf)
          : cardBlockConfirm(memberId, card.last4, card.product, csrf),
      );
      return;
    }

    const cardsReissueMatch = url.pathname.match(/^\/member\/([^/]+)\/cards\/([^/]+)\/reissue$/);
    if (cardsReissueMatch) {
      const memberId = cardsReissueMatch[1] ?? "";
      const last4 = decodeURIComponent(cardsReissueMatch[2] ?? "");
      const member = lookupMember(memberId);
      if (!member) {
        send(res, 200, notFoundPage(memberId));
        return;
      }
      if (member.status === "restricted") {
        send(res, 200, deniedPage(memberId));
        return;
      }
      const card = lookupCard(memberId, last4, ctx.cards);
      if (!card) {
        send(res, 200, cardNotFoundPage(memberId, last4));
        return;
      }
      if (req.method === "POST") {
        const body = new URLSearchParams(await readBody(req));
        if (!ctx.tokens.consume(body.get("csrf") ?? undefined, `reissue:${memberId}:${card.last4}`)) {
          send(res, 400, invalidTokenPage());
          return;
        }
        if (card.accountKind === "business") {
          send(res, 200, legacyOn ? workCardBusiness(memberId, card.last4) : cardBusinessPage(memberId, card.last4));
          return;
        }
        if (card.status !== "blocked" || !card.reissueReady) {
          redirect(res, `/member/${memberId}/cards/${encodeURIComponent(card.last4)}/block`);
          return;
        }
        let action;
        try {
          action = ctx.cardActions.insert({ member_id: memberId, last4: card.last4 });
        } catch (err) {
          if (err instanceof DuplicateCardActionError) {
            const existing = ctx.cardActions.lookup(memberId, card.last4);
            const caseNumber = existing?.case_number ?? card.caseNumber ?? "CASE-88001";
            markCardReissued(memberId, card.last4, caseNumber, ctx.cards);
            const updated = lookupCard(memberId, card.last4, ctx.cards)!;
            send(res, 200, legacyOn ? workCardDetail(updated) : cardDetailPage(updated));
            return;
          }
          throw err;
        }
        markCardReissued(memberId, card.last4, action.case_number, ctx.cards);
        redirect(res, `/member/${memberId}/cards/${encodeURIComponent(card.last4)}/done`);
        return;
      }
      if (req.method !== "GET") {
        send(res, 405, methodNotAllowedPage(req.method ?? "GET", url.pathname));
        return;
      }
      if (card.accountKind === "business") {
        send(res, 200, legacyOn ? workCardBusiness(memberId, card.last4) : cardBusinessPage(memberId, card.last4));
        return;
      }
      if (ctx.cardActions.has(memberId, card.last4) || card.caseNumber) {
        send(res, 200, legacyOn ? workCardDetail(card) : cardDetailPage(card));
        return;
      }
      if (card.status !== "blocked" || !card.reissueReady) {
        redirect(res, `/member/${memberId}/cards/${encodeURIComponent(card.last4)}/block`);
        return;
      }
      const csrf = ctx.tokens.issue(`reissue:${memberId}:${card.last4}`);
      send(
        res,
        200,
        legacyOn
          ? workCardReissue(memberId, card.last4, card.product, csrf)
          : cardReissueConfirm(memberId, card.last4, card.product, csrf),
      );
      return;
    }

    const cardsDoneMatch = url.pathname.match(/^\/member\/([^/]+)\/cards\/([^/]+)\/done$/);
    if (cardsDoneMatch) {
      const memberId = cardsDoneMatch[1] ?? "";
      const last4 = decodeURIComponent(cardsDoneMatch[2] ?? "");
      const stored = ctx.cardActions.lookup(memberId, last4);
      const card = lookupCard(memberId, last4, ctx.cards);
      const caseNumber = stored?.case_number ?? card?.caseNumber ?? "CASE-88001";
      send(
        res,
        200,
        legacyOn ? workCardDone(memberId, last4, caseNumber) : cardDone(memberId, last4, caseNumber),
      );
      return;
    }

    const cardsDetailMatch = url.pathname.match(/^\/member\/([^/]+)\/cards\/([^/]+)$/);
    if (cardsDetailMatch) {
      const memberId = cardsDetailMatch[1] ?? "";
      const last4 = decodeURIComponent(cardsDetailMatch[2] ?? "");
      const member = lookupMember(memberId);
      if (!member) {
        send(res, 200, notFoundPage(memberId));
        return;
      }
      if (member.status === "restricted") {
        send(res, 200, deniedPage(memberId));
        return;
      }
      const card = lookupCard(memberId, last4, ctx.cards);
      if (!card) {
        send(res, 200, cardNotFoundPage(memberId, last4));
        return;
      }
      send(res, 200, legacyOn ? workCardDetail(card) : cardDetailPage(card));
      return;
    }

    if (url.pathname === "/admin/wire" || url.pathname.startsWith("/admin/")) {
      send(res, 200, adminWirePage());
      return;
    }

    send(res, 404, searchPage({ error: "Screen not found." }));
}

function listenHost(): string {
  return process.env.RELAY_BIND_HOST?.trim() || "127.0.0.1";
}

export async function startConsole(port = 0, options: ConsoleOptions = {}): Promise<ConsoleServer> {
  const filings = new FilingsStore();
  const tokens = new FormTokenStore();
  const disputes = cloneDisputes();
  const cards = cloneCards();
  const cardActions = new CardActionsStore();
  const skin = options.skin ?? skinById(process.env.RELAY_CONSOLE_SKIN);
  const server = createConsoleServer(filings, { ...options, skin }, tokens, disputes, cards, cardActions);
  const host = listenHost();
  await new Promise<void>((resolve, reject) => {
    server.listen(port, host, () => resolve());
    server.on("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("console failed to bind");
  }
  return {
    port: address.port,
    origin: `http://127.0.0.1:${address.port}`,
    filings,
    tokens,
    cardActions,
    skin,
    reset: () => {
      filings.reset();
      tokens.reset();
      resetDisputes(disputes);
      resetCards(cards);
      cardActions.reset();
    },
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("server.ts")) {
  const port = Number(process.env.RELAY_CONSOLE_PORT ?? 3000);
  const started = await startConsole(port);
  const published = listenHost() === "0.0.0.0" ? ` (host: http://localhost:${started.port})` : "";
  console.log(`Relay Credit Union console: ${started.origin}${published}`);
}
