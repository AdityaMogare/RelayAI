import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startConsole, type ConsoleServer } from "../apps/bank-console/server.ts";

function csrfFrom(html: string): string {
  const token = html.match(/name="csrf" value="([^"]+)"/)?.[1];
  expect(token).toBeTruthy();
  return token!;
}

async function postForm(origin: string, path: string, body: string): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    redirect: "follow",
  });
}

describe("CAMS card console", () => {
  let server: ConsoleServer;

  beforeAll(async () => {
    server = await startConsole(0);
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    server.reset();
  });

  it("blocks and reissues 4412 with a CASE-88 case number", async () => {
    const blockPage = await fetch(`${server.origin}/member/12345/cards/4412/block`);
    const blockHtml = await blockPage.text();
    expect(blockHtml).toMatch(/Confirm Card Block/);
    const blockToken = csrfFrom(blockHtml);

    const afterBlock = await postForm(server.origin, "/member/12345/cards/4412/block", `csrf=${blockToken}`);
    expect(afterBlock.status).toBe(200);
    const reissueHtml = await afterBlock.text();
    expect(reissueHtml).toMatch(/Confirm Card Reissue/);
    const reissueToken = csrfFrom(reissueHtml);

    const done = await postForm(server.origin, "/member/12345/cards/4412/reissue", `csrf=${reissueToken}`);
    expect(done.status).toBe(200);
    const doneHtml = await done.text();
    expect(doneHtml).toMatch(/CASE-88\d+/);
    expect(doneHtml).toMatch(/blocked and reissued/i);
    expect(server.cardActions.exec("SELECT count(*) FROM card_actions WHERE member_id='12345' AND last4='4412'").count).toBe(1);
  });

  it("treats already-blocked 7788 as a terminal console state, not a write", async () => {
    const detail = await fetch(`${server.origin}/member/12345/cards/7788`);
    const html = await detail.text();
    expect(html).toMatch(/Card already blocked/);
    expect(html).not.toMatch(/Block Card/);
    const block = await fetch(`${server.origin}/member/12345/cards/7788/block`);
    expect(await block.text()).toMatch(/Card already blocked/);
    expect(server.cardActions.exec("SELECT count(*) FROM card_actions WHERE member_id='12345' AND last4='7788'").count).toBe(0);
  });

  it("routes business-account 3301 to supervisor and does not write", async () => {
    const detail = await fetch(`${server.origin}/member/12345/cards/3301`);
    const html = await detail.text();
    expect(html).toMatch(/Business account — supervisor required/);
    expect(html).not.toMatch(/Block Card/);
    const block = await fetch(`${server.origin}/member/12345/cards/3301/block`);
    expect(await block.text()).toMatch(/Business account — supervisor required/);
    expect(server.cardActions.exec("SELECT count(*) FROM card_actions WHERE member_id='12345' AND last4='3301'").count).toBe(0);
  });

  it("a second 4412 reissue does not insert a second card_actions row", async () => {
    const blockPage = await fetch(`${server.origin}/member/12345/cards/4412/block`);
    const afterBlock = await postForm(
      server.origin,
      "/member/12345/cards/4412/block",
      `csrf=${csrfFrom(await blockPage.text())}`,
    );
    await postForm(server.origin, "/member/12345/cards/4412/reissue", `csrf=${csrfFrom(await afterBlock.text())}`);
    expect(server.cardActions.exec("SELECT count(*) FROM card_actions WHERE member_id='12345' AND last4='4412'").count).toBe(1);

    const again = await fetch(`${server.origin}/member/12345/cards/4412/block`);
    expect(await again.text()).toMatch(/Card already blocked/);
    const duplicate = await postForm(server.origin, "/member/12345/cards/4412/reissue", "csrf=stale");
    expect(duplicate.status).toBe(400);
    expect(server.cardActions.exec("SELECT count(*) FROM card_actions WHERE member_id='12345' AND last4='4412'").count).toBe(1);
  });
});
