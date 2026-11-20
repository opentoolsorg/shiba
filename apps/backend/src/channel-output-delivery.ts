import { deliverableMediaType, isSafeDeliverablePath, parseChatThreadName, type DelegatedRun } from "@shiba/shared";
import { createChannelAdapter } from "./ports/channel/registry.js";
import type { ChannelAdapter, ChannelMessageRef } from "./ports/channel/index.js";
import type { Env } from "./env.js";
import { deliverableStorageKey } from "./run-deliverables.js";
import { verifySlackBotInstallation } from "./slack.js";
import { parseSlackThreadName } from "./slack-thread.js";

const MIB = 1024 * 1024;
const UPLOAD_LIMIT = { slack: 32 * MIB, discord: 20 * MIB, telegram: 32 * MIB };

export type OutputDestination =
  | { channel: "slack"; placeId: string; threadId: string; teamId: string }
  | { channel: "discord" | "telegram"; placeId: string; threadId?: string };

export function channelOutputDestination(name: string): OutputDestination | null {
  const slack = parseSlackThreadName(name);
  if (slack && [slack.channelId, slack.teamId].every((part) => /^[A-Za-z0-9_-]{1,128}$/.test(part))) {
    return { channel: "slack", placeId: slack.channelId, threadId: slack.threadTs, teamId: slack.teamId };
  }
  const ids = parseChatThreadName(name);
  if (ids?.platform === "discord") return { channel: "discord", placeId: ids.conversationId };
  if (ids?.platform === "telegram") return { channel: "telegram", placeId: ids.conversationId, ...(ids.topicId ? { threadId: ids.topicId } : {}) };
  return null;
}

export function channelOutputsEnabled(env: Pick<Env, "SHIBA_CHANNEL_OUTPUT_DELIVERY">): boolean {
  return env.SHIBA_CHANNEL_OUTPUT_DELIVERY !== "0";
}

export async function channelOutputAdapter(env: Env, destination: OutputDestination): Promise<ChannelAdapter | null> {
  if (destination.channel === "slack") {
    const token = env.SLACK_BOT_TOKEN?.trim();
    if (!token || (await verifySlackBotInstallation(token)).teamId !== destination.teamId) return null;
  }
  return createChannelAdapter(env, destination.channel);
}

export function outputDashboardUrl(env: Pick<Env, "WORKER_HOSTNAME">, kind: "runs" | "outputs"): string {
  const host = env.WORKER_HOSTNAME?.trim() || "app.tryshiba.dev";
  const base = new URL(host.includes("://") ? host : `https://${host}`);
  if (base.protocol !== "https:" || base.username || base.password) throw new Error("Invalid dashboard origin.");
  return new URL(kind === "runs" ? "/work/" : "/outputs/", base.origin).href;
}

export async function claimChannelOutput(bucket: R2Bucket, parts: readonly string[]): Promise<string | null> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(parts))));
  const key = "channel-output-receipts/" + Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
  // Claim before the external call. None of these APIs can rule out acceptance after a lost response.
  return await bucket.put(key, JSON.stringify({ state: "attempting" }), { onlyIf: { etagDoesNotMatch: "*" } }) ? key : null;
}

interface ChannelOutputFile {
  id: string;
  path: string;
  bytes: number;
  read(): Promise<R2ObjectBody | null>;
  kind: "runs" | "outputs";
}

export async function deliverChannelOutputs(
  env: Pick<Env, "ATTACHMENTS" | "WORKER_HOSTNAME" | "SHIBA_CHANNEL_OUTPUT_DELIVERY">,
  input: { threadName: string; sourceId: string; files: readonly ChannelOutputFile[] },
  resolve: (target: OutputDestination) => Promise<Pick<ChannelAdapter, "channel" | "upload" | "post"> | null>,
): Promise<void> {
  if (!channelOutputsEnabled(env) || !env.ATTACHMENTS || input.files.length === 0) return;
  const destination = channelOutputDestination(input.threadName);
  if (!destination) return;
  const adapter = await resolve(destination);
  if (!adapter || adapter.channel !== destination.channel) return;
  const target = { placeId: destination.placeId, ...(destination.threadId ? { threadId: destination.threadId } : {}) };
  const limit = UPLOAD_LIMIT[destination.channel];
  for (const file of input.files) {
    if (!isSafeDeliverablePath(file.path)) continue;
    const filename = file.path.split("/").at(-1)!;
    const contentType = deliverableMediaType(file.path)!;
    const dashboard = outputDashboardUrl(env, file.kind);
    const key = await claimChannelOutput(env.ATTACHMENTS, ["file", input.sourceId, file.id]);
    if (!key) continue;
    let failure: string | undefined;
    let ref: ChannelMessageRef | undefined;
    try {
      if (file.bytes > limit) {
        failure = `${filename} is too large to attach here (limit: ${limit / MIB} MiB).`;
      } else {
        const object = await file.read();
        if (!object || object.size !== file.bytes) throw new Error("Output body is unavailable.");
        const buffer = await object.arrayBuffer();
        if (buffer.byteLength !== file.bytes) throw new Error("Output bytes do not match the saved file.");
        ref = await adapter.upload({ ...target, filename, contentType, data: new Uint8Array(buffer), comment: `Output: ${filename}\nOpen in Shiba: ${dashboard}` });
        if (!ref.messageId || ref.placeId !== target.placeId || ref.threadId !== target.threadId) {
          ref = undefined;
          throw new Error("Unconfirmed upload destination.");
        }
      }
    } catch {
      failure = `Shiba could not confirm that ${filename} was attached.`;
    }
    let failureRef: ChannelMessageRef | undefined;
    if (failure) {
      failureRef = await adapter.post({ ...target, text: `${failure} Open in Shiba: ${dashboard}` }).catch(() => undefined);
    }
    await env.ATTACHMENTS.put(key, JSON.stringify({ state: ref ? "posted" : "not_confirmed", ref, failureRef }));
  }
}

export async function channelMediaFiles(env: Env, runId: string, ownerId: string, workspaceId: string): Promise<ChannelOutputFile[]> {
  if (!env.AGENT_AUDIT) return [];
  const rows = await env.AGENT_AUDIT.prepare(
    `SELECT f.id, f.name, f.mime, f.size, f.r2_key
     FROM media_generations m JOIN files f ON f.id=m.file_id AND f.workspace_id=m.workspace_id AND f.created_by=m.created_by
     WHERE m.run_id=? AND m.created_by=? AND m.workspace_id=? AND f.archived_at IS NULL
     AND ((m.kind='image' AND f.mime IN ('image/png','image/jpeg','image/webp','image/gif')) OR (m.kind='video' AND f.mime='video/mp4'))
     ORDER BY m.created_at, f.id LIMIT 8`,
  ).bind(runId, ownerId, workspaceId).all<{ id: string; name: string; mime: string; size: number; r2_key: string }>();
  return rows.results.filter((row) => deliverableMediaType(row.name) === row.mime).map((row) => ({
    id: row.id, path: row.name, bytes: row.size, kind: "outputs",
    read: async () => {
      return await (row.mime === "video/mp4" ? env.ARTIFACTS : env.FILES ?? env.ARTIFACTS)?.get(row.r2_key) ?? null;
    },
  }));
}

export async function deliverCompletedRunOutputs(
  env: Env, threadName: string, run: DelegatedRun, mediaOwner?: string,
  resolve: (target: OutputDestination) => Promise<Pick<ChannelAdapter, "channel" | "upload" | "post"> | null> = (target) => channelOutputAdapter(env, target),
): Promise<void> {
  if (!channelOutputsEnabled(env) || !channelOutputDestination(threadName) || run.status !== "completed" ||
      !run.approval || run.parentRunId || run.reviewOf || run.personalExecution || run.slackCommandOrigin ||
      run.routineRun || run.collaborationHandoffId) return;
  const files: ChannelOutputFile[] = (run.deliverables ?? []).map((item, index) => ({
    id: `deliverable:${index}:${item.sha256}`, path: item.path, bytes: item.bytes, kind: "runs",
    read: async () => await env.ATTACHMENTS?.get(deliverableStorageKey(run.sandboxId, item.sha256, index)) ?? null,
  }));
  if (mediaOwner) {
    const ownerWorkspace = (run.orgId ?? "self-hosted").replace(/^team:/, "");
    files.push(...await channelMediaFiles(env, run.runId, mediaOwner, ownerWorkspace).catch(() => []));
  }
  await deliverChannelOutputs(env, { threadName, sourceId: run.runId, files }, resolve);
}
