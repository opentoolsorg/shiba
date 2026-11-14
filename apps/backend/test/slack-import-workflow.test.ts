import { describe, expect, it } from "vitest";
import { ensureCollaborationSchema } from "../src/collaboration-store.js";
import type { Env } from "../src/env.js";
import { COLLAB_TENANT_ID, COLLAB_WORKSPACE_ID } from "../src/collaboration-store.js";
import {
  createSlackImportJob,
  mockSlackHistoryPager,
  processSlackImportPage,
  recordSlackImportedMessage,
} from "../src/slack-import/store.js";
import { applyCollabV2Migrations } from "./fixtures/collab-v2-migrations.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

describe("slack import workflow paging", () => {
  it("imports mock pages idempotently on slack ts", async () => {
    const { database, sqlite } = customAgentD1();
    const env = { AGENT_AUDIT: database } as unknown as Env;
    await ensureCollaborationSchema(env);
    applyCollabV2Migrations(sqlite);
    const job = await createSlackImportJob(env, {
      tenantId: COLLAB_TENANT_ID,
      workspaceId: COLLAB_WORKSPACE_ID,
      roomId: "room_import",
      slackTeamId: "T_TEST",
      slackChannelId: "C_TEST",
      requestedByUserId: "owner@example.test",
      createdAt: 1,
    });
    let writes = 0;
    await processSlackImportPage(env, job, mockSlackHistoryPager, 10, async () => {
      writes += 1;
      return `slack_import_${writes}`;
    });
    const firstCount = sqlite.prepare("SELECT COUNT(*) AS count FROM slack_imported_messages").get() as { count: number };
    expect(firstCount.count).toBe(2);
    const duplicate = await recordSlackImportedMessage(env, {
      tenantId: job.tenantId,
      workspaceId: job.workspaceId,
      jobId: job.jobId,
      slackChannelId: job.slackChannelId,
      slackTs: "1710000001.000100",
      messageId: "slack_import_dup",
      importedAt: 11,
    });
    expect(duplicate).toBe(false);
  });
});