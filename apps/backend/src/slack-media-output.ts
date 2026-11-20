import { z } from "zod";
import type { SlackInstallationSnapshot } from "@shiba/shared";
import { channelMediaFiles, channelOutputAdapter, channelOutputDestination, channelOutputsEnabled, claimChannelOutput, deliverChannelOutputs, outputDashboardUrl } from "./channel-output-delivery.js";
import type { Env } from "./env.js";
import { createSlackAdapter } from "./channels/slack/index.js";
import { activeSlackInstallationForTeam, readSlackInstallationCredential } from "./slack-installations-store.js";
import { generateImage } from "./tools/image-gen.js";
import { generateVideo, videoCapabilityForUser } from "./tools/video-gen.js";

const VIDEO_APPROVAL_TTL = 10 * 60_000;
const REQUEST = /^generate\s+(image|video)\s+([\s\S]+)$/i;
const ID = /^[a-zA-Z0-9_-]{1,128}$/;
export const SLACK_VIDEO_APPROVE_ACTION = "shiba_approve_video";
export const isSlackMediaCommand = (text: string) => REQUEST.test(text);

const mediaInputSchema = z.object({
  id: z.string().regex(ID),
  threadName: z.string().max(300),
  slackUserId: z.string().regex(ID),
  prompt: z.string().trim().min(1).max(2000),
  kind: z.enum(["image", "video"]),
  installation: z.object({ id: z.string(), generation: z.number().int() }).optional(),
  owner: z.object({ userId: z.string(), workspaceId: z.string() }).optional(),
});
export type SlackMediaWorkflowInput = z.infer<typeof mediaInputSchema>;
const approvalSchema = mediaInputSchema.extend({ createdAt: z.number().int().positive() });

async function linkedMediaOwner(env: Env, installation: SlackInstallationSnapshot, slackUserId: string) {
  return env.AGENT_AUDIT.prepare(
    `SELECT b.actor_id AS userId, b.workspace_id AS workspaceId
     FROM slack_coworker_bindings b
     JOIN team_workspace_memberships m ON m.workspace_id=b.workspace_id AND m.user_id=b.actor_id
     JOIN shiba_auth_account_policy p ON p.account_id=b.account_id AND p.email=b.actor_id
     JOIN "user" u ON u.id=p.account_id AND lower(u.email)=b.actor_id AND u.emailVerified=1
     WHERE b.installation_id=? AND b.generation=? AND b.workspace_id=? AND b.slack_user_id=? AND b.status='active'
     AND m.tenant_id='self-hosted' AND m.status='active' AND m.version=b.member_version AND m.role=b.member_role`,
  ).bind(installation.id, installation.generation, installation.workspaceId, slackUserId).first<{ userId: string; workspaceId: string }>();
}

async function mediaAdapter(env: Env, threadName: string, pin?: SlackMediaWorkflowInput["installation"]) {
  const dest = channelOutputDestination(threadName);
  if (dest?.channel !== "slack") return null;
  if (!pin) {
    const adapter = await channelOutputAdapter(env, dest);
    return adapter ? { dest, adapter } : null;
  }
  const installation = await activeSlackInstallationForTeam(env, env.SLACK_OAUTH_APP_ID ?? "", dest.teamId);
  if (!installation || installation.id !== pin.id || installation.generation !== pin.generation) return null;
  const { token } = await readSlackInstallationCredential(env, installation);
  return { dest, installation, adapter: createSlackAdapter({ token }) };
}

async function ownerStillLinked(env: Env, input: SlackMediaWorkflowInput, installation?: SlackInstallationSnapshot) {
  if (!input.owner || !installation?.scopes.includes("files:write")) return false;
  const owner = await linkedMediaOwner(env, installation, input.slackUserId);
  return owner?.userId === input.owner.userId && owner.workspaceId === input.owner.workspaceId;
}

const approvalKey = (id: string) => `slack-media-intents/${id}`;
const runIdFor = (id: string) => `slack-media:${id}`;

/** Called only with the signed Slack event's own text, not its thread history. */
export async function requestSlackMedia(
  env: Env,
  event: { id: string; threadName: string; slackUserId: string; text: string },
  installation?: SlackInstallationSnapshot,
): Promise<boolean> {
  const command = REQUEST.exec(event.text);
  if (!command || !channelOutputsEnabled(env)) return false;
  const pin = installation ? { id: installation.id, generation: installation.generation } : undefined;
  const lane = await mediaAdapter(env, event.threadName, pin).catch(() => null);
  if (!lane) return true;
  const { dest, adapter } = lane;
  const target = { placeId: dest.placeId, threadId: dest.threadId };
  try {
    const parsed = mediaInputSchema.safeParse({ ...event, kind: command[1]?.toLowerCase(), prompt: command[2], installation: pin });
    if (!parsed.success) {
      await adapter.post({ ...target, text: "Describe the image or video in 1–2000 characters." });
      return true;
    }
    const input = parsed.data;
    if (!env.SLACK_MEDIA_WORKFLOW || !env.ATTACHMENTS) {
      await adapter.post({ ...target, text: "Media generation is not configured for this Slack app." });
      return true;
    }
    if (lane.installation) {
      const owner = await linkedMediaOwner(env, lane.installation, input.slackUserId);
      if (!owner || !lane.installation.scopes.includes("files:write")) {
        await adapter.post({ ...target, text: "Link your Slack user to Shiba and ask your admin to verify the app has the files:write permission." });
        return true;
      }
      input.owner = owner;
    }
    if (input.kind === "image") {
      if (await claimChannelOutput(env.ATTACHMENTS, ["slack-media-start", input.threadName, input.id])) {
        await env.SLACK_MEDIA_WORKFLOW.create({ id: input.id, params: input });
      }
      return true;
    }
    if (!input.owner || !(await videoCapabilityForUser(env, input.owner.userId)).enabled) {
      await adapter.post({ ...target, text: "To generate video in Slack, link this Slack user to your Shiba workspace and connect your Google key in Settings → Providers." });
      return true;
    }
    const stored = await env.ATTACHMENTS.put(approvalKey(input.id), JSON.stringify({ ...input, createdAt: Date.now() }), {
      onlyIf: { etagDoesNotMatch: "*" },
    });
    if (stored) {
      await adapter.post({
        ...target,
        text: "Video generation uses your connected Google account. Confirm to generate and attach an eight-second video to this thread.",
        native: { blocks: [
          { type: "section", text: { type: "plain_text", text: `Generate and attach an eight-second video? This uses your connected Google account and may incur a charge.\n\nPrompt: ${input.prompt}` } },
          { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Generate video" }, style: "primary", action_id: SLACK_VIDEO_APPROVE_ACTION, value: input.id }] },
        ] },
      });
    }
  } catch {
    await adapter.post({ ...target, text: "Shiba could not queue media generation. Please send a new request." }).catch(() => undefined);
  }
  return true;
}

/** The existing signed, allowlisted Slack interaction route calls this exact-payload approval. */
export async function confirmSlackVideo(env: Env, input: { id: string; threadName: string; slackUserId: string }, installation: SlackInstallationSnapshot): Promise<boolean> {
  if (!env.ATTACHMENTS || !env.SLACK_MEDIA_WORKFLOW || !channelOutputsEnabled(env) || !ID.test(input.id)) return false;
  const object = await env.ATTACHMENTS.get(approvalKey(input.id));
  if (!object || object.size > 12_000) return false;
  const record = approvalSchema.safeParse(await object.json());
  if (!record.success) return false;
  const { createdAt, ...intent } = record.data;
  if (intent.kind !== "video" || intent.id !== input.id || intent.threadName !== input.threadName ||
      intent.slackUserId !== input.slackUserId || createdAt > Date.now() || Date.now() - createdAt > VIDEO_APPROVAL_TTL ||
      intent.installation?.id !== installation.id || intent.installation.generation !== installation.generation) return false;
  if (!intent.owner || !await ownerStillLinked(env, intent, installation) || !(await videoCapabilityForUser(env, intent.owner.userId)).enabled) return false;
  if (!await claimChannelOutput(env.ATTACHMENTS, ["slack-media-start", intent.threadName, intent.id])) return true;
  await env.SLACK_MEDIA_WORKFLOW.create({ id: intent.id, params: intent });
  await env.ATTACHMENTS.put(approvalKey(intent.id), JSON.stringify({ state: "queued" }));
  return true;
}

export type SlackMediaResult =
  | { ok: false }
  | { ok: true; userId: string; workspaceId: string }
  | { ok: true; key: string; bytes: number; path: string };

export async function generateSlackMedia(env: Env, raw: SlackMediaWorkflowInput): Promise<SlackMediaResult> {
  const parsed = mediaInputSchema.safeParse(raw);
  if (!parsed.success || !channelOutputsEnabled(env)) return { ok: false };
  const input = parsed.data;
  const lane = await mediaAdapter(env, input.threadName, input.installation);
  if (!lane || (input.installation && !await ownerStillLinked(env, input, lane.installation))) return { ok: false };
  const runId = runIdFor(input.id);
  const owner = input.owner;
  if (input.kind === "video") {
    if (!input.installation || !owner) return { ok: false };
    const result = await generateVideo(env, { prompt: input.prompt }, { ...owner, runId });
    return result.ok === true ? { ok: true, ...owner } : { ok: false };
  }
  const result = await generateImage(env, { prompt: input.prompt, runId, ...owner });
  if (!result.ok) return { ok: false };
  if (owner) return { ok: true, ...owner };
  if (!result.key || !result.bytes) return { ok: false };
  return { ok: true, key: result.key, path: result.key.endsWith(".png") ? "Generated image.png" : "Generated image.jpg", bytes: result.bytes };
}

export async function postSlackMediaResult(env: Env, input: SlackMediaWorkflowInput, result: SlackMediaResult): Promise<void> {
  if (!channelOutputsEnabled(env)) return;
  const lane = await mediaAdapter(env, input.threadName, input.installation);
  if (!lane || (input.installation && !await ownerStillLinked(env, input, lane.installation))) return;
  const { adapter, dest } = lane;
  const runId = runIdFor(input.id);
  const files = result.ok
    ? "userId" in result ? await channelMediaFiles(env, runId, result.userId, result.workspaceId)
      : [{ id: result.key, path: result.path, bytes: result.bytes, kind: "outputs" as const, read: async () => await (env.FILES ?? env.ARTIFACTS)?.get(result.key) ?? null }]
    : [];
  if (files.length) {
    await deliverChannelOutputs(env, { threadName: input.threadName, sourceId: runId, files }, async () => adapter);
  } else {
    if (env.ATTACHMENTS && await claimChannelOutput(env.ATTACHMENTS, ["slack-media-failed", input.threadName, input.id])) {
      const retryNote = input.kind === "video" ? " Check your provider account before retrying; it may have charged for the job." : "";
      await adapter.post({ placeId: dest.placeId, threadId: dest.threadId, text: `Shiba could not finish or find the generated ${input.kind}.${retryNote} Open in Shiba: ${outputDashboardUrl(env, "outputs")}` });
    }
  }
}
