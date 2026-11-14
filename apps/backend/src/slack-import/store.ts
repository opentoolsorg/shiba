import { ensureCollabV2Migrated, finalizeMessageV2, nextMessageSeq } from "../collaboration-v2-store.js";
import { createCollaborationMessage, humanActorId } from "../collaboration-store.js";
import type { Env } from "../env.js";
import { randomHex } from "../mailbox-store.js";

export class SlackImportStoreError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "SlackImportStoreError";
  }
}

export type SlackImportJobStatus = "pending" | "running" | "completed" | "cancelled" | "failed";

export interface SlackImportJobRow {
  jobId: string;
  tenantId: string;
  workspaceId: string;
  roomId: string;
  slackTeamId: string;
  slackChannelId: string;
  requestedByUserId: string;
  status: SlackImportJobStatus;
  cursorTs: string | null;
  importedCount: number;
  errorDetail: string | null;
  workflowInstanceId: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

function rowJob(row: Record<string, unknown>): SlackImportJobRow {
  return {
    jobId: String(row.job_id),
    tenantId: String(row.tenant_id),
    workspaceId: String(row.workspace_id),
    roomId: String(row.room_id),
    slackTeamId: String(row.slack_team_id),
    slackChannelId: String(row.slack_channel_id),
    requestedByUserId: String(row.requested_by_user_id),
    status: row.status as SlackImportJobStatus,
    cursorTs: typeof row.cursor_ts === "string" ? row.cursor_ts : null,
    importedCount: Number(row.imported_count ?? 0),
    errorDetail: typeof row.error_detail === "string" ? row.error_detail : null,
    workflowInstanceId: typeof row.workflow_instance_id === "string" ? row.workflow_instance_id : null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    completedAt: row.completed_at === null || row.completed_at === undefined ? null : Number(row.completed_at),
  };
}

export async function ensureSlackImportMigrated(env: Pick<Env, "AGENT_AUDIT">): Promise<void> {
  await ensureCollabV2Migrated(env);
  const table = await env.AGENT_AUDIT.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='slack_import_jobs'",
  ).first();
  if (!table) throw new SlackImportStoreError("Slack import storage is not migrated.", 503);
}

export async function createSlackImportJob(
  env: Pick<Env, "AGENT_AUDIT">,
  input: {
    tenantId: string;
    workspaceId: string;
    roomId: string;
    slackTeamId: string;
    slackChannelId: string;
    requestedByUserId: string;
    workflowInstanceId?: string;
    createdAt: number;
  },
): Promise<SlackImportJobRow> {
  await ensureSlackImportMigrated(env);
  const jobId = `sij_${randomHex(10)}`;
  await env.AGENT_AUDIT.prepare(
    `INSERT INTO slack_import_jobs (job_id,tenant_id,workspace_id,room_id,slack_team_id,slack_channel_id,requested_by_user_id,status,workflow_instance_id,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,'pending',?,?,?)`,
  )
    .bind(
      jobId,
      input.tenantId,
      input.workspaceId,
      input.roomId,
      input.slackTeamId,
      input.slackChannelId,
      input.requestedByUserId,
      input.workflowInstanceId ?? null,
      input.createdAt,
      input.createdAt,
    )
    .run();
  return (await getSlackImportJob(env, input.tenantId, input.workspaceId, jobId))!;
}

export async function getSlackImportJob(
  env: Pick<Env, "AGENT_AUDIT">,
  tenantId: string,
  workspaceId: string,
  jobId: string,
): Promise<SlackImportJobRow | null> {
  await ensureSlackImportMigrated(env);
  const row = await env.AGENT_AUDIT.prepare(
    "SELECT * FROM slack_import_jobs WHERE tenant_id=? AND workspace_id=? AND job_id=?",
  )
    .bind(tenantId, workspaceId, jobId)
    .first<Record<string, unknown>>();
  return row ? rowJob(row) : null;
}

export async function cancelSlackImportJob(
  env: Pick<Env, "AGENT_AUDIT">,
  tenantId: string,
  workspaceId: string,
  jobId: string,
  updatedAt: number,
): Promise<boolean> {
  const result = await env.AGENT_AUDIT.prepare(
    `UPDATE slack_import_jobs SET status='cancelled', updated_at=?, completed_at=?
     WHERE tenant_id=? AND workspace_id=? AND job_id=? AND status IN ('pending','running')`,
  )
    .bind(updatedAt, updatedAt, tenantId, workspaceId, jobId)
    .run();
  return Number(result.meta?.changes ?? 0) === 1;
}

export async function advanceSlackImportJob(
  env: Pick<Env, "AGENT_AUDIT">,
  tenantId: string,
  workspaceId: string,
  jobId: string,
  input: { status: SlackImportJobStatus; cursorTs?: string; importedCount?: number; errorDetail?: string; updatedAt: number; completedAt?: number },
): Promise<void> {
  await env.AGENT_AUDIT.prepare(
    `UPDATE slack_import_jobs SET status=?, cursor_ts=COALESCE(?, cursor_ts),
      imported_count=COALESCE(?, imported_count), error_detail=COALESCE(?, error_detail),
      updated_at=?, completed_at=COALESCE(?, completed_at)
     WHERE tenant_id=? AND workspace_id=? AND job_id=?`,
  )
    .bind(
      input.status,
      input.cursorTs ?? null,
      input.importedCount ?? null,
      input.errorDetail ?? null,
      input.updatedAt,
      input.completedAt ?? null,
      tenantId,
      workspaceId,
      jobId,
    )
    .run();
}

export interface SlackPageMessage {
  ts: string;
  threadTs?: string;
  text: string;
  userId: string;
}

/** Testable paging seam — production workflow calls Slack APIs; fixtures inject pages. */
export type SlackHistoryPager = (input: {
  teamId: string;
  channelId: string;
  cursorTs?: string | null;
}) => Promise<{ messages: SlackPageMessage[]; nextCursorTs: string | null }>;

export const mockSlackHistoryPager: SlackHistoryPager = async ({ cursorTs }) => {
  if (cursorTs) return { messages: [], nextCursorTs: null };
  return {
    messages: [
      { ts: "1710000001.000100", text: "Imported hello", userId: "U_IMPORT" },
      { ts: "1710000002.000200", threadTs: "1710000001.000100", text: "Imported reply", userId: "U_IMPORT" },
    ],
    nextCursorTs: "1710000002.000200",
  };
};

export async function recordSlackImportedMessage(
  env: Pick<Env, "AGENT_AUDIT">,
  input: {
    tenantId: string;
    workspaceId: string;
    jobId: string;
    slackChannelId: string;
    slackTs: string;
    slackThreadTs?: string;
    messageId: string;
    importedAt: number;
  },
): Promise<boolean> {
  const result = await env.AGENT_AUDIT.prepare(
    `INSERT INTO slack_imported_messages (tenant_id,workspace_id,job_id,slack_channel_id,slack_ts,slack_thread_ts,message_id,imported_at)
     VALUES (?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
  )
    .bind(
      input.tenantId,
      input.workspaceId,
      input.jobId,
      input.slackChannelId,
      input.slackTs,
      input.slackThreadTs ?? null,
      input.messageId,
      input.importedAt,
    )
    .run();
  return Number(result.meta?.changes ?? 0) === 1;
}

async function mirrorSlackMessageIntoRoom(
  env: Pick<Env, "AGENT_AUDIT">,
  job: SlackImportJobRow,
  message: SlackPageMessage,
  messageId: string,
  now: number,
): Promise<void> {
  const scope = {
    tenantId: job.tenantId,
    workspaceId: job.workspaceId,
    userId: job.requestedByUserId,
  };
  const saved = await createCollaborationMessage(env, scope, {
    messageId,
    tenantId: job.tenantId,
    workspaceId: job.workspaceId,
    roomId: job.roomId,
    senderUserId: job.requestedByUserId,
    senderActorId: humanActorId(job.requestedByUserId),
    senderKind: "human",
    body: message.text.slice(0, 4000),
    profileVersion: null,
    createdAt: now,
  });
  if (!saved) return;
  const parentTs = message.threadTs && message.threadTs !== message.ts ? message.threadTs : null;
  let threadRoot: string | null = null;
  if (parentTs) {
    const parent = await env.AGENT_AUDIT.prepare(
      `SELECT message_id FROM slack_imported_messages
       WHERE tenant_id=? AND workspace_id=? AND slack_channel_id=? AND slack_ts=?`,
    )
      .bind(job.tenantId, job.workspaceId, job.slackChannelId, parentTs)
      .first<{ message_id: string }>();
    threadRoot = parent?.message_id ?? null;
  }
  const seq = await nextMessageSeq(env, scope, job.roomId);
  await finalizeMessageV2(env, scope, messageId, {
    roomId: job.roomId,
    messageSeq: seq,
    threadRootMessageId: threadRoot,
    replyToMessageId: threadRoot,
    messageRole: threadRoot ? "progress" : "chat",
  });
}

export async function processSlackImportPage(
  env: Pick<Env, "AGENT_AUDIT">,
  job: SlackImportJobRow,
  pager: SlackHistoryPager,
  now: number,
  writeMessage: (message: SlackPageMessage) => Promise<string>,
): Promise<SlackImportJobRow> {
  const page = await pager({
    teamId: job.slackTeamId,
    channelId: job.slackChannelId,
    cursorTs: job.cursorTs,
  });
  let imported = 0;
  for (const message of page.messages) {
    const messageId = await writeMessage(message);
    const inserted = await recordSlackImportedMessage(env, {
      tenantId: job.tenantId,
      workspaceId: job.workspaceId,
      jobId: job.jobId,
      slackChannelId: job.slackChannelId,
      slackTs: message.ts,
      slackThreadTs: message.threadTs,
      messageId,
      importedAt: now,
    });
    if (inserted) {
      imported += 1;
      await mirrorSlackMessageIntoRoom(env, job, message, messageId, now);
    }
  }
  const done = !page.nextCursorTs;
  await advanceSlackImportJob(env, job.tenantId, job.workspaceId, job.jobId, {
    status: done ? "completed" : "running",
    cursorTs: page.nextCursorTs ?? job.cursorTs ?? undefined,
    importedCount: job.importedCount + imported,
    updatedAt: now,
    completedAt: done ? now : undefined,
  });
  return (await getSlackImportJob(env, job.tenantId, job.workspaceId, job.jobId))!;
}