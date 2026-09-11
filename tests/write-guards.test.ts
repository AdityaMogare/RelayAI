import { describe, expect, it } from "vitest";
import { startConsole } from "../apps/bank-console/server.ts";

describe("irreversible console writes", () => {
  it("rejects GET submit and GET sub-account confirm", async () => {
    const server = await startConsole(0);
    try {
      const submit = await fetch(`${server.origin}/member/12345/disputes/DSP-1001/submit?reason=Unauthorized`);
      expect(submit.status).toBe(405);
      const confirm = await fetch(`${server.origin}/member/12345/sub-account/confirm?product=Share%20Savings`);
      expect(confirm.status).toBe(405);
    } finally {
      await server.close();
    }
  });

  it("rejects Confirm without a form token and files once with a token", async () => {
    const server = await startConsole(0);
    try {
      const bare = await fetch(`${server.origin}/member/12345/disputes/DSP-1001/submit`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "reason=Unauthorized",
      });
      expect(bare.status).toBe(400);

      const review = await fetch(`${server.origin}/member/12345/disputes/DSP-1001/file?step=review&reason=Unauthorized`);
      const html = await review.text();
      const token = html.match(/name="csrf" value="([^"]+)"/)?.[1];
      expect(token).toBeTruthy();
      const filed = await fetch(`${server.origin}/member/12345/disputes/DSP-1001/submit`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `reason=Unauthorized&csrf=${token}`,
      });
      expect(filed.status).toBe(200);
      expect(await filed.text()).toMatch(/Dispute DSP-1001 filed/);
      expect(server.filings.countByDisputeId("DSP-1001")).toBe(1);

      const review2 = await fetch(`${server.origin}/member/12345/disputes/DSP-1001/file?step=review&reason=Unauthorized`);
      expect(await review2.text()).toMatch(/Dispute already filed/);
    } finally {
      await server.close();
    }
  });

  it("rejects bare POST and PUT on card block and reissue", async () => {
    const server = await startConsole(0);
    try {
      const bareBlock = await fetch(`${server.origin}/member/12345/cards/4412/block`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "",
      });
      expect(bareBlock.status).toBe(400);

      const bareReissue = await fetch(`${server.origin}/member/12345/cards/4412/reissue`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "",
      });
      expect(bareReissue.status).toBe(400);

      const putBlock = await fetch(`${server.origin}/member/12345/cards/4412/block`, { method: "PUT" });
      expect(putBlock.status).toBe(405);
      const putReissue = await fetch(`${server.origin}/member/12345/cards/4412/reissue`, { method: "PUT" });
      expect(putReissue.status).toBe(405);
    } finally {
      await server.close();
    }
  });
});
