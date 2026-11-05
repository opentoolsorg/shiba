import { verifySlackBotInstallation } from "../../src/slack.js";
import { postReportSlackMessage } from "../../src/report-slack-sender.js";

/** Local workerd fixture. Every network request is intercepted by the parent test. */
export default { async fetch(request: Request): Promise<Response> {
  const url = new URL(request.url), token = url.searchParams.has("redirect") ? "fixture-redirect" : "fixture-token";
  try {
    const value = url.pathname === "/auth"
      ? await verifySlackBotInstallation(token)
      : await postReportSlackMessage(token, { channel: "C123", threadTs: "1.1", text: "Fixture reviewed text", clientMsgId: "00000000-0000-4000-8000-000000000001" });
    return Response.json({ ok: true, value });
  } catch { return Response.json({ ok: false }); }
} };
