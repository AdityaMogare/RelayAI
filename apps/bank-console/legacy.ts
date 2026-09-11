import type { Member } from "./data.ts";
import { productsForTier } from "./data.ts";
import { renderPage } from "./html.ts";

/** Start at ctl07 so a recorded CSS `#...ctl04...` locator is already stale on first paint. */
let ctlTick = 1;

export function nextGeneratedId(): string {
  const n = [4, 7, 11][ctlTick % 3];
  ctlTick += 1;
  return `ctl00_ctl32_dgAcct_ctl${String(n).padStart(2, "0")}_lblVal`;
}

export function framesetPage(workSrc = "/frames/work?screen=search"): string {
  return `<!DOCTYPE html>
<html>
<head><title>Relay Credit Union — Member Servicing</title></head>
<frameset cols="180,*">
  <frame name="nav" src="/frames/nav">
  <frame name="work" src="${workSrc}">
</frameset>
</html>`;
}

export function navFrame(): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { margin: 8px; font-family: Tahoma, sans-serif; font-size: 12px; background: #dcd6b8; }
    a { display: block; margin: 6px 0; }
    input { width: 90%; }
  </style>
</head>
<body>
  <p><strong>Nav</strong></p>
  <form action="/frames/work" method="get" target="work">
    <input type="hidden" name="screen" value="search">
    <div>Member ID</div>
    <input type="text" name="mid" aria-label="Member ID" autocomplete="off">
    <div>Last Name</div>
    <input type="text" name="last" aria-label="Last Name" autocomplete="off">
    <button type="submit">Search</button>
  </form>
  <a href="/frames/work?screen=search" target="work">Lookup</a>
</body>
</html>`;
}

export function workSearch(opts: { error?: string; notice?: boolean | "always" } = {}): string {
  const err = opts.error ? `<p class="err" role="alert">${opts.error}</p>` : "";
  return renderPage(
    "Relay Credit Union — Member Servicing",
    `
      <p>Member Lookup</p>
      ${err}
      <form action="/frames/work" method="get">
        <input type="hidden" name="screen" value="search">
        <table>
          <tr><td>Member ID</td><td><input type="text" name="mid" aria-label="Member ID" autocomplete="off"></td></tr>
          <tr><td>Last Name</td><td><input type="text" name="last" aria-label="Last Name" autocomplete="off"></td></tr>
          <tr><td colspan="2"><button type="submit">Search</button></td></tr>
        </table>
      </form>
    `,
    opts.notice === "always" ? "always" : opts.notice ? "once" : false,
  );
}

export function workMember(m: Member): string {
  const id = nextGeneratedId();
  const products = productsForTier(m.tier).join(", ");
  return renderPage(
    `Relay Credit Union — Member ${m.id}`,
    `
      <fieldset>
        <legend>Member Search</legend>
        <table role="presentation" cellpadding="2"><tr>
          <td>Member ID</td>
          <td><input type="text" name="mid_search" value="${m.id}"></td>
        </tr></table>
      </fieldset>
      <fieldset>
        <legend>Account Queue</legend>
        <table role="presentation" cellpadding="2"><tr>
          <td>Member ID</td>
          <td><input type="text" name="mid_queue"></td>
        </tr></table>
      </fieldset>
      <table cellpadding="2" id="dgAcct">
        <tr>
          <td class="lbl">Savings Balance</td>
          <td id="${id}" aria-label="Savings Balance">${m.savings}</td>
        </tr>
        <tr>
          <td class="lbl">Checking Balance</td>
          <td aria-label="Checking Balance">${m.checking}</td>
        </tr>
        <tr>
          <td class="lbl">Name</td>
          <td>${m.name}</td>
        </tr>
        <tr>
          <td class="lbl">Eligible products</td>
          <td>${products}</td>
        </tr>
      </table>
      <fieldset>
        <legend>Dispute Detail</legend>
        <table role="presentation" cellpadding="2"><tr>
          <td>Member ID</td>
          <td><input type="text" name="mid_dispute"></td>
        </tr></table>
      </fieldset>
      <p>
        <a href="/member/${m.id}/sub-account">Open Sub-Account</a>
        &nbsp;|&nbsp;
        <a href="/member/${m.id}/disputes">Disputes</a>
        &nbsp;|&nbsp;
        <a href="/member/${m.id}/cards">CAMS</a>
        &nbsp;|&nbsp;
        <a href="/frames/work?screen=search">New Search</a>
      </p>
    `,
  );
}

export function workMemberResults(
  lastName: string,
  page: { rows: { id: string; name: string }[]; page: number; pages: number },
): string {
  const rows = page.rows
    .map(
      (row) => `<tr>
        <td>${row.id}</td>
        <td>${row.name}</td>
        <td><a href="/frames/work?screen=member&mid=${row.id}">Details</a></td>
      </tr>`,
    )
    .join("");
  const next =
    page.page < page.pages
      ? `<a href="/frames/work?screen=search&last=${encodeURIComponent(lastName)}&page=${page.page + 1}">Next</a>`
      : "";
  return renderPage(
    "Relay Credit Union — Search results",
    `
      <p>Member Lookup</p>
      <p>Last name ${lastName} — page ${page.page} of ${page.pages}.</p>
      <table>
        <tr><th>ID</th><th>Name</th><th></th></tr>
        ${rows}
      </table>
      <p>${next}</p>
    `,
  );
}

export function workCardList(
  memberId: string,
  rows: { last4: string; product: string; status: string; account: string }[],
  error?: string,
): string {
  const err = error ? `<p class="err" role="alert">${error}</p>` : "";
  const body =
    rows.length === 0
      ? `<p>No cards on this member.</p>`
      : `<table>
        <tr><th>Last 4</th><th>Product</th><th>Status</th><th>Account</th><th></th></tr>
        ${rows
          .map(
            (r) => `<tr>
            <td>${r.last4}</td>
            <td>${r.product}</td>
            <td>${r.status}</td>
            <td>${r.account}</td>
            <td><a href="/member/${memberId}/cards/${r.last4}">Open</a></td>
          </tr>`,
          )
          .join("")}
      </table>`;
  return renderPage(
    "Relay Credit Union — CAMS Card Batch",
    `
      <p>CAMS — Card Batch</p>
      <p>Member ${memberId}</p>
      ${err}
      <form action="/member/${memberId}/cards/open" method="get">
        <table>
          <tr><td>Card last 4</td><td><input type="text" name="last4" aria-label="Card last 4" autocomplete="off"></td></tr>
          <tr><td colspan="2"><button type="submit">Open by last 4</button></td></tr>
        </table>
      </form>
      ${body}
      <p><a href="/frames/work?screen=member&mid=${memberId}">Return to Member</a></p>
    `,
  );
}

export function workCardDetail(c: {
  memberId: string;
  last4: string;
  product: string;
  status: string;
  accountKind: string;
  holder: string;
  caseNumber?: string;
}): string {
  const blocked = c.status === "blocked";
  const business = c.accountKind === "business";
  const alert = blocked
    ? `<p class="err" role="alert">Card already blocked</p>
       <p>Card ending ${c.last4} is already blocked${c.caseNumber ? `. Case ${c.caseNumber}` : ""}.</p>`
    : business
      ? `<p class="err" role="alert">Business account — supervisor required</p>
         <p>This card sits on a business account. A supervisor must take the block and reissue.</p>`
      : "";
  const action =
    blocked || business
      ? ""
      : `<p><a href="/member/${c.memberId}/cards/${c.last4}/block">Block Card</a></p>`;
  return renderPage(
    `Relay Credit Union — Card ${c.last4}`,
    `
      <p>Card ${c.last4}</p>
      <p>Member ${c.memberId}</p>
      ${alert}
      <table>
        <tr><td>Holder</td><td>${c.holder}</td></tr>
        <tr><td>Product</td><td>${c.product}</td></tr>
        <tr><td>Card Last 4</td><td>${c.last4}</td></tr>
        <tr><td>Status</td><td>${blocked ? "Blocked" : "Active"}</td></tr>
        <tr><td>Account</td><td>${business ? "Business" : "Personal"}</td></tr>
      </table>
      ${action}
      <p><a href="/member/${c.memberId}/cards">Back to CAMS</a></p>
    `,
  );
}

export function workCardBusiness(memberId: string, last4: string): string {
  return renderPage(
    "Relay Credit Union — Supervisor required",
    `
      <p class="err" role="alert">Business account — supervisor required</p>
      <p>Card ending ${last4} on member ${memberId} sits on a business account. A supervisor must take the block and reissue.</p>
      <p><a href="/member/${memberId}/cards/${last4}">Back to Card</a></p>
    `,
  );
}

export function workCardBlock(memberId: string, last4: string, product: string, csrf: string): string {
  return renderPage(
    "Relay Credit Union — Confirm Card Block",
    `
      <p>Confirm Card Block</p>
      <p>Blocking <strong>${product}</strong> ending <strong>${last4}</strong> for member ${memberId}.</p>
      <p>This action is irreversible once confirmed.</p>
      <form action="/member/${memberId}/cards/${last4}/block" method="post">
        <input type="hidden" name="csrf" value="${csrf}">
        <button type="submit">Confirm</button>
        <a href="/member/${memberId}/cards/${last4}">Back</a>
      </form>
    `,
  );
}

export function workCardReissue(memberId: string, last4: string, product: string, csrf: string): string {
  return renderPage(
    "Relay Credit Union — Confirm Card Reissue",
    `
      <p>Confirm Card Reissue</p>
      <p>Reissuing <strong>${product}</strong> ending <strong>${last4}</strong> for member ${memberId}.</p>
      <p>This action is irreversible once confirmed.</p>
      <form action="/member/${memberId}/cards/${last4}/reissue" method="post">
        <input type="hidden" name="csrf" value="${csrf}">
        <button type="submit">Confirm</button>
        <a href="/member/${memberId}/cards/${last4}">Back</a>
      </form>
    `,
  );
}

export function workCardDone(memberId: string, last4: string, caseNumber: string): string {
  return renderPage(
    "Relay Credit Union — Card reissued",
    `
      <p class="ok" role="status" aria-label="Confirmation">Confirmation: Card ${last4} blocked and reissued. Case ${caseNumber}.</p>
      <p><a href="/frames/work?screen=member&mid=${memberId}">Return to Member</a></p>
    `,
  );
}

