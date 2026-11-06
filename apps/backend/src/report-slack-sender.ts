import { SlackPostRejectedError, SLACK_POST_TIMEOUT_MS } from "./slack.js";

/** Fixed Slack endpoint; no formatting, mentions, broadcast, metadata or link crawling. */
export async function postReportSlackMessage(token: string, input: {
  channel: string; threadTs: string; text: string; clientMsgId: string;
}): Promise<{ channel: string; ts: string }> {
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST", redirect: "manual", signal: AbortSignal.timeout(SLACK_POST_TIMEOUT_MS),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel: input.channel, thread_ts: input.threadTs, text: input.text, client_msg_id: input.clientMsgId,
      mrkdwn: false, parse: "none", link_names: false, reply_broadcast: false,
      unfurl_links: false, unfurl_media: false, unfurl_app_links: false }),
  });
  // Never reflect Slack's raw error, token or response text into a report/room.
  const reader = response.body?.getReader();
  const bytes = new Uint8Array(16_384); let used = 0;
  let value: { ok?: unknown; channel?: unknown; ts?: unknown; error?: unknown; warning?: unknown; response_metadata?: { warnings?: unknown } };
  try {
    if (!reader) throw new Error();
    for (;;) { const part = await reader.read(); if (part.done) break;
      if (used + part.value.length > bytes.length) throw new Error();
      bytes.set(part.value, used); used += part.value.length;
    }
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes.subarray(0, used)));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
  } catch { throw new Error("report_slack_outcome_unknown"); }
  finally { await reader?.cancel().catch(() => {}); }
  if (!response.ok || value.ok === false) {
    const uncertain = ["fatal_error", "internal_error", "request_timeout"].includes(String(value.error));
    throw new SlackPostRejectedError("report_slack_rejected", !uncertain && (response.ok || response.status >= 400 && response.status < 500));
  }
  if (value.ok !== true || typeof value.channel !== "string" || typeof value.ts !== "string" || !/^\d{1,20}\.\d{1,20}$/.test(value.ts) ||
    value.warning !== undefined || (Array.isArray(value.response_metadata?.warnings) && value.response_metadata.warnings.length > 0)) throw new Error("report_slack_outcome_unknown");
  return { channel: value.channel, ts: value.ts };
}
