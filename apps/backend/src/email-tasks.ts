/**
 * Email task lane: a DMARC-authenticated mail from an allowlisted sender to
 * a registered employee mailbox becomes a pending run approval.
 *
 * The lane only queues. The approval lives on the shared orchestrator, the
 * same queue email-send approvals use, so it shows in the dashboard
 * Approvals list (DASHBOARD_APPROVERS decide) and, when
 * SLACK_APPROVALS_CHANNEL is set, as a Slack card (SLACK_APPROVERS decide).
 * A reply by email never decides anything: a bare "approve" gets a refusal
 * and any other reply is just another request that needs its own approval.
 *
 * Publication linkage matches the other chat lanes: the run is queued with
 * publishPullRequest, so when its changes are ready a second immutable
 * pr_publish approval gates the pull request. Email thread keys are not
 * chat conversations, so that second card follows the orchestrator's
 * email fallback — the authenticated dashboard Approvals list always, the
 * Slack approvals channel when configured. The email channel itself never
 * renders a decision affordance: an emailed "approve" for publication is
 * refused exactly like one for the run.
 *
 * Senders outside the allowlist, unauthenticated mail, and automated mail
 * get no reply, so the lane cannot be used to bounce mail at third parties.
 */
import { parseChatTaskRequest, queueChatRun, type ResolveOrchestrator } from "./chat-lane.js";
import {
  cleanSubject,
  emailTransport,
  stripQuotedReply,
  type EmailEnvelope,
} from "./channels/email/index.js";
import type { Env } from "./env.js";
import { orchestratorNameFor } from "./platform/do-resolver.js";
import type { ChannelAdapter } from "./ports/channel/index.js";
import { createChannelAdapter } from "./ports/channel/registry.js";
import { redactSecrets } from "./security.js";
import {
  approvalCardText,
  buildApprovalBlocks,
  slackCanvasUrl,
  type ApprovalCardInput,
} from "./slack-approval.js";
import { parseChannelRepoMap } from "./slack-context.js";
import { postSlackMessage } from "./slack.js";
import { MAX_APPROVED_TASK_CHARS } from "./task-limits.js";

const EMAIL_TASK_USAGE =
  "Put the task in the subject or body and include a https://github.com/owner/repo URL, or ask your administrator to map this mailbox in EMAIL_TASK_REPOS.";

const DECISION_REPLY =
  /^(?:approved?|approval|accept(?:ed)?|reject(?:ed)?|deny|denied|decline[d]?|yes|no|y|n|ok(?:ay)?|lgtm|go ahead|ship it|confirm(?:ed)?)[\s.!]*$/i;

type EmailTaskOutcome =
  | { status: "queued"; approvalId: string }
  | { status: "refused"; reason: string }
  | { status: "ignored"; reason: string };

interface EmailTaskDeps {
  resolveOrchestrator?: ResolveOrchestrator;
  /** Outbound reply adapter; defaults to the email channel's SEND_EMAIL adapter. */
  adapter?: ChannelAdapter | null;
  postSlack?: typeof postSlackMessage;
}

export async function handleEmailTaskRequest(
  env: Env,
  input: { rawBody: string; headers: Headers },
  deps: EmailTaskDeps = {},
): Promise<EmailTaskOutcome> {
  const verified = await emailTransport.verify(input.rawBody, input.headers, env);
  if (!verified.ok) return { status: "ignored", reason: verified.error };
  const message = emailTransport.parse(input.rawBody);
  if (message?.kind !== "message") return { status: "ignored", reason: "Not an email message." };
  if (message.isBot)
    return { status: "ignored", reason: "Automated mail is never a task request." };
  if (
    !env.EMAIL_TASK_SENDERS?.split(",").some(
      (entry) => entry.trim().toLowerCase() === message.authorId,
    )
  ) {
    return { status: "ignored", reason: "Sender is not on EMAIL_TASK_SENDERS." };
  }
  const mailbox = message.workspaceId ?? "";
  const employees = parseChannelRepoMap(env.EMAIL_TASK_EMPLOYEES);
  const employee = Object.hasOwn(employees, mailbox) ? employees[mailbox]?.trim() : undefined;
  if (!employee) return { status: "ignored", reason: "Mailbox is not configured for task intake." };
  const envelopeSubject = (message.raw as EmailEnvelope).subject;
  const subject = /^re:/i.test(envelopeSubject)
    ? envelopeSubject
    : `Re: ${envelopeSubject || "your Shiba request"}`;
  const adapter = deps.adapter === undefined ? createChannelAdapter(env, "email") : deps.adapter;
  const reply = async (text: string): Promise<void> => {
    if (!adapter) return;
    await adapter
      .post({
        placeId: message.placeId,
        replyToMessageId: message.messageId,
        text,
        native: {
          from: mailbox,
          subject: subject.replace(/[\r\n]+/g, " ").slice(0, 300),
        },
      })
      .catch(() => console.warn("email_task_reply_failed"));
  };

  const body = stripQuotedReply((message.raw as EmailEnvelope).text);
  if (DECISION_REPLY.test(body || cleanSubject(envelopeSubject))) {
    await reply(
      "Email replies cannot approve or reject Shiba work. Nothing was decided.\n\n" +
        "An approver decides pending requests in the Shiba dashboard Approvals list or in Slack.",
    );
    return { status: "refused", reason: "Email cannot decide approvals." };
  }

  if ((message.raw as EmailEnvelope).inReplyTo && !body) {
    return { status: "ignored", reason: "The email reply does not contain a new request." };
  }
  if (message.text.length > MAX_APPROVED_TASK_CHARS) {
    const reason =
      "Nothing was queued. Shorten the subject and body to 4,000 characters and send a new email.";
    await reply(reason);
    return { status: "refused", reason };
  }
  const parsed = parseChatTaskRequest({
    text: message.text,
    conversationId: mailbox,
    repoMap: env.EMAIL_TASK_REPOS,
    mapName: "EMAIL_TASK_REPOS",
    usage: EMAIL_TASK_USAGE,
  });
  if ("error" in parsed) {
    await reply(`Nothing was queued. ${parsed.error}`);
    return { status: "refused", reason: parsed.error };
  }

  const threadKey = orchestratorNameFor(env, {});
  const queued = await queueChatRun(
    env,
    {
      platform: "email",
      threadKey,
      repoUrl: parsed.repoUrl,
      task: parsed.task,
      userId: message.authorId,
      customAgentId: employee,
      publishPullRequest: true,
    },
    deps.resolveOrchestrator,
  );
  if ("error" in queued) {
    const reason =
      "Shiba could not queue your request. Ask your Shiba administrator to check the mailbox and employee configuration.";
    await reply(reason);
    return { status: "refused", reason };
  }

  const dashboard = slackCanvasUrl(env.WORKER_HOSTNAME);
  const approvalsUrl = dashboard && new URL("/approvals/", dashboard).href;
  const card: ApprovalCardInput = {
    threadKey,
    approvalId: queued.approvalId,
    repoUrl: parsed.repoUrl,
    task: `Emailed by ${message.authorId}: ${redactSecrets(parsed.task)}\nOpen the dashboard to see the full frozen input.`,
    employeeLabel: employee,
    ...(approvalsUrl ? { canvasUrl: approvalsUrl } : {}),
  };
  const slackChannel = env.SLACK_APPROVALS_CHANNEL?.trim();
  const slackToken = env.SLACK_BOT_TOKEN?.trim();
  if (slackChannel && slackToken) {
    await (deps.postSlack ?? postSlackMessage)(slackToken, {
      channel: slackChannel,
      text: approvalCardText(card).slice(0, 3000),
      blocks: buildApprovalBlocks(card),
    }).catch(() => console.warn("email_task_slack_card_failed"));
  }

  await reply(
    [
      "Your request is waiting for approval. Nothing runs until an approver accepts it in the Shiba dashboard or Slack.",
      "",
      `Approval: ${queued.approvalId}`,
      ...(approvalsUrl ? [`Open Shiba Approvals: ${approvalsUrl}`] : []),
      "",
      "If the approved work produces repository changes, publishing them as a pull request requires a separate approval in the Shiba dashboard or Slack.",
      "Replying to this email cannot approve or reject the request.",
    ].join("\n"),
  );
  return { status: "queued", approvalId: queued.approvalId };
}
