/* eslint-disable no-restricted-imports -- Adapters sit three levels deep but stay inside the backend app. */
import { redactSecrets } from "../../../security.js";
import { approvalCardText, buildApprovalBlocks, type ApprovalCardInput } from "../../../slack-approval.js";

/** Preserve the original unthreaded email card transport during port extraction. */
export async function postLegacySlackEmailApproval(
  token: string, channel: string, input: ApprovalCardInput,
): Promise<void> {
  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      channel,
      text: approvalCardText(input).slice(0, 3000),
      blocks: buildApprovalBlocks(input),
    }),
  })
    .then(async (response) => {
      // Slack reports app-level failures (not_in_channel, …) as HTTP 200 with ok:false.
      const body = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
      } | null;
      if (!response.ok || body?.ok !== true) {
        console.error(
          `Slack email approval card post failed (${response.status}): ${body?.error ?? "unparseable response"}`,
        );
      }
    })
    .catch((error) => {
      console.error("Slack email approval card post failed", redactSecrets(String(error)));
    });
}
