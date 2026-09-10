function shell(title: string, body: string, extraHead = ""): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <style>
    body { margin: 0; background: #c9c2a8; font-family: Tahoma, Verdana, sans-serif; font-size: 13px; color: #222; }
    .outer { width: 100%; border-collapse: collapse; background: #dcd6b8; }
    .banner { background: #1f4a7a; color: #fff; font-weight: bold; padding: 8px 12px; font-size: 16px; }
    .sub { background: #8a7d4e; color: #fff; padding: 4px 12px; }
    .work { padding: 16px; }
    .inner { border-collapse: collapse; background: #f4f0dc; border: 2px solid #7a7048; width: 100%; }
    .inner td, .inner th { border: 1px solid #b0a878; padding: 6px 10px; text-align: left; }
    .inner th { background: #e6dfc0; }
    a, button, input[type=submit] { font-family: inherit; }
    button, input[type=submit] { background: #1f4a7a; color: #fff; border: 1px solid #0d2744; padding: 4px 12px; cursor: pointer; }
    input[type=text], select { border: 1px solid #666; padding: 3px 6px; }
    .notice { position: fixed; inset: 0; background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; }
    .notice-box { background: #fff8dc; border: 3px outset #888; padding: 16px 20px; width: 360px; }
    .err { color: #8b0000; font-weight: bold; }
    .ok { color: #0a5c0a; font-weight: bold; }
    iframe { border: 1px solid #7a7048; width: 100%; height: 42px; background: #fff; }
  </style>
  ${extraHead}
</head>
<body>
${body}
</body>
</html>`;
}

function chrome(inner: string, notice = false): string {
  const overlay = notice
    ? `<div class="notice" role="dialog" aria-label="System Notice">
        <div class="notice-box">
          <p><strong>System Notice</strong></p>
          <p>Scheduled core maintenance window in 30 minutes. Continue only if this work is urgent.</p>
          <form method="get" action="">
            <button type="submit" name="notice" value="0">Dismiss</button>
          </form>
        </div>
      </div>`
    : "";
  return `
<table class="outer" width="100%" cellpadding="0" cellspacing="0">
  <tr><td class="banner">RELAY CREDIT UNION — Member Servicing</td></tr>
  <tr><td class="sub">Core Banking Console &nbsp;|&nbsp; Institution: Demo CU &nbsp;|&nbsp; Operator: teller01</td></tr>
  <tr><td class="work">
    <iframe src="/ticker" title="Rate board"></iframe>
    <table class="inner" cellpadding="0" cellspacing="0"><tr><td>
      ${inner}
    </td></tr></table>
  </td></tr>
</table>
${overlay}`;
}

export function searchPage(opts: { notice?: boolean; error?: string }): string {
  const err = opts.error ? `<p class="err" role="alert">${opts.error}</p>` : "";
  return shell(
    "Relay Credit Union — Member Servicing",
    chrome(
      `<p>Member Lookup</p>
       ${err}
       <form action="/search" method="get">
         <table>
           <tr>
             <td>Member ID</td>
             <td><input type="text" name="mid" aria-label="Member ID" autocomplete="off"></td>
           </tr>
           <tr>
             <td colspan="2"><button type="submit">Search</button></td>
           </tr>
         </table>
       </form>`,
      opts.notice,
    ),
  );
}

export function tickerPage(): string {
  return `<!DOCTYPE html><html><body style="margin:4px;font-family:Tahoma;font-size:12px;background:#fffef2;">
    <span>Share draft APY 0.05% &nbsp;|&nbsp; Regular share 0.15% &nbsp;|&nbsp; 12-mo cert 3.40%</span>
  </body></html>`;
}

export function notFoundPage(id: string): string {
  return shell(
    "Relay Credit Union — Member not found",
    chrome(`
      <p class="err" role="alert">Member not found</p>
      <p>No member record matches the ID provided (${id}).</p>
      <p><a href="/">Back to Search</a></p>
    `),
  );
}

export function deniedPage(id: string): string {
  return shell(
    "Relay Credit Union — Access denied",
    chrome(`
      <p class="err" role="alert">Permission denied</p>
      <p>You are not authorized to view member ${id}. This record is restricted.</p>
      <p><a href="/">Back to Search</a></p>
    `),
  );
}

export function expiredPage(): string {
  return shell(
    "Relay Credit Union — Session expired",
    chrome(`
      <p class="err" role="alert">Session expired</p>
      <p>Your teller session has timed out. Sign in again to continue.</p>
      <p><a href="/">Return to Search</a></p>
    `),
  );
}

export function memberPage(m: {
  id: string;
  name: string;
  savings: string;
  checking: string;
}): string {
  return shell(
    `Relay Credit Union — Member ${m.id}`,
    chrome(`
      <h1>Member ${m.id}</h1>
      <table>
        <tr><th>Name</th><td>${m.name}</td></tr>
        <tr><th>Status</th><td>Active</td></tr>
        <tr><th>Savings Balance</th><td aria-label="Savings Balance">${m.savings}</td></tr>
        <tr><th>Checking Balance</th><td aria-label="Checking Balance">${m.checking}</td></tr>
      </table>
      <p>
        <a href="/member/${m.id}/sub-account">Open Sub-Account</a>
        &nbsp;|&nbsp;
        <a href="/member/${m.id}/disputes">Disputes</a>
        &nbsp;|&nbsp;
        <a href="/">New Search</a>
      </p>
    `),
  );
}

export function subAccountForm(memberId: string, error?: string): string {
  const err = error ? `<p class="err" role="alert">${error}</p>` : "";
  return shell(
    `Relay Credit Union — Open Sub-Account`,
    chrome(`
      <h1>Open Sub-Account</h1>
      <p>Member ${memberId}</p>
      ${err}
      <form action="/member/${memberId}/sub-account" method="get">
        <table>
          <tr>
            <td>Product</td>
            <td>
              <select name="product" aria-label="Product">
                <option value="">-- select --</option>
                <option>Share Savings</option>
                <option>Money Market</option>
                <option>Certificate</option>
              </select>
            </td>
          </tr>
          <tr>
            <td colspan="2">
              <button type="submit" name="step" value="review">Continue</button>
              <a href="/member/${memberId}">Cancel</a>
            </td>
          </tr>
        </table>
      </form>
    `),
  );
}

export function subAccountReview(memberId: string, product: string): string {
  return shell(
    `Relay Credit Union — Confirm Sub-Account`,
    chrome(`
      <h1>Confirm Sub-Account</h1>
      <p>Opening <strong>${product}</strong> for member ${memberId}.</p>
      <p>This action is irreversible once confirmed.</p>
      <form action="/member/${memberId}/sub-account/confirm" method="get">
        <input type="hidden" name="product" value="${product}">
        <button type="submit">Confirm</button>
        <a href="/member/${memberId}/sub-account">Back</a>
      </form>
    `),
  );
}

export function disputeListPage(
  memberId: string,
  rows: { id: string; merchant: string; amount: string; status: string }[],
  error?: string,
): string {
  const err = error ? `<p class="err" role="alert">${error}</p>` : "";
  const body =
    rows.length === 0
      ? `<p>No open or filed disputes on this member.</p>`
      : `<table>
        <tr><th>ID</th><th>Merchant</th><th>Status</th></tr>
        ${rows
          .map(
            (r) => `<tr>
            <td>${r.id}</td>
            <td>${r.merchant}</td>
            <td>${r.status}</td>
          </tr>`,
          )
          .join("")}
      </table>`;
  return shell(
    `Relay Credit Union — Dispute Queue`,
    chrome(`
      <h1>Dispute Queue</h1>
      <p>Member ${memberId}</p>
      ${err}
      <form action="/member/${memberId}/disputes/open" method="get">
        <table>
          <tr>
            <td>Dispute ID</td>
            <td><input type="text" name="did" aria-label="Dispute ID" autocomplete="off"></td>
          </tr>
          <tr>
            <td colspan="2"><button type="submit">Open</button></td>
          </tr>
        </table>
      </form>
      ${body}
      <p><a href="/member/${memberId}">Return to Member</a></p>
    `),
  );
}

export function disputeNotFoundPage(memberId: string, disputeId: string): string {
  return shell(
    "Relay Credit Union — Dispute not found",
    chrome(`
      <p class="err" role="alert">Dispute not found</p>
      <p>No dispute ${disputeId} exists for member ${memberId}.</p>
      <p><a href="/member/${memberId}/disputes">Back to Dispute Queue</a></p>
    `),
  );
}

export function disputeDetailPage(d: {
  id: string;
  memberId: string;
  merchant: string;
  amount: string;
  posted: string;
  last4: string;
  status: string;
  caseNumber?: string;
}): string {
  const filed = d.status === "filed";
  const alert = filed
    ? `<p class="err" role="alert">Dispute already filed</p>
       <p>Case ${d.caseNumber ?? "CASE-66110"} is already in review. This item cannot be filed again.</p>`
    : "";
  const action = filed
    ? ""
    : `<p><a href="/member/${d.memberId}/disputes/${d.id}/file">File Dispute</a></p>`;
  return shell(
    `Relay Credit Union — Dispute ${d.id}`,
    chrome(`
      <h1>Dispute ${d.id}</h1>
      <p>Member ${d.memberId}</p>
      ${alert}
      <table>
        <tr><th>Merchant</th><td aria-label="Merchant">${d.merchant}</td></tr>
        <tr><th>Transaction Amount</th><td aria-label="Transaction Amount">${d.amount}</td></tr>
        <tr><th>Card Last 4</th><td aria-label="Card Last 4">${d.last4}</td></tr>
        <tr><th>Posted</th><td>${d.posted}</td></tr>
        <tr><th>Status</th><td aria-label="Dispute Status">${filed ? "Filed" : "Open"}</td></tr>
      </table>
      ${action}
      <p><a href="/member/${d.memberId}/disputes">Back to Dispute Queue</a></p>
    `),
  );
}

export function disputeFileForm(memberId: string, disputeId: string, error?: string): string {
  const err = error ? `<p class="err" role="alert">${error}</p>` : "";
  return shell(
    `Relay Credit Union — File Card Dispute`,
    chrome(`
      <h1>File Card Dispute</h1>
      <p>Member ${memberId} &nbsp;|&nbsp; ${disputeId}</p>
      ${err}
      <form action="/member/${memberId}/disputes/${disputeId}/file" method="get">
        <table>
          <tr>
            <td>Reason</td>
            <td>
              <select name="reason" aria-label="Reason">
                <option value="">-- select --</option>
                <option>Unauthorized</option>
                <option>Duplicate</option>
                <option>Incorrect amount</option>
              </select>
            </td>
          </tr>
          <tr>
            <td colspan="2">
              <button type="submit" name="step" value="review">Continue</button>
              <a href="/member/${memberId}/disputes/${disputeId}">Cancel</a>
            </td>
          </tr>
        </table>
      </form>
    `),
  );
}

export function disputeReview(memberId: string, disputeId: string, reason: string, amount: string): string {
  return shell(
    `Relay Credit Union — Confirm Dispute Filing`,
    chrome(`
      <h1>Confirm Dispute Filing</h1>
      <p>Filing <strong>${disputeId}</strong> for ${amount} as <strong>${reason}</strong>.</p>
      <p>This action is irreversible once confirmed.</p>
      <form action="/member/${memberId}/disputes/${disputeId}/submit" method="get">
        <input type="hidden" name="reason" value="${reason}">
        <button type="submit">Confirm</button>
        <a href="/member/${memberId}/disputes/${disputeId}/file">Back</a>
      </form>
    `),
  );
}

export function disputeDone(memberId: string, disputeId: string, reason: string): string {
  return shell(
    `Relay Credit Union — Dispute filed`,
    chrome(`
      <h1>Dispute filed</h1>
      <p class="ok" role="status" aria-label="Confirmation">Confirmation: Dispute ${disputeId} filed (${reason}). Case CASE-77201.</p>
      <p><a href="/member/${memberId}">Return to Member</a></p>
    `),
  );
}

export function subAccountDone(memberId: string, product: string): string {
  return shell(
    `Relay Credit Union — Sub-account opened`,
    chrome(`
      <h1>Sub-account opened</h1>
      <p class="ok" role="status" aria-label="Confirmation">Confirmation: ${product} is now open for member ${memberId}.</p>
      <p>Confirmation number ACCT-88421.</p>
      <p><a href="/member/${memberId}">Return to Member</a></p>
    `),
  );
}
