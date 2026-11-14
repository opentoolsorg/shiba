import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { ensureCollaborationSchema } from "../src/collaboration-store.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

it.each([false, true])("initializes collaboration executor pinning and source deduplication (existing executor column: %s)", async (existingExecutor) => {
  const { database, sqlite } = customAgentD1();
  try {
    sqlite.exec(readFileSync(new URL("../migrations/0046_collab_v2.sql", import.meta.url), "utf8"));
    if (existingExecutor) sqlite.exec("ALTER TABLE collaboration_handoffs ADD COLUMN executor_agent_name TEXT");
    await ensureCollaborationSchema({ AGENT_AUDIT: database });
    sqlite.exec(`INSERT INTO collaboration_rooms (
      room_id, tenant_id, workspace_id, title, visibility, created_by_user_id, created_at
    ) VALUES ('room_1', 'self-hosted', 'ws_1', 'Work', 'private', 'owner@example.test', 1);
    INSERT INTO collaboration_memberships (
      tenant_id, workspace_id, room_id, user_id, display_name, actor_id, actor_kind,
      role, status, capabilities_json, created_at
    ) VALUES
      ('self-hosted', 'ws_1', 'room_1', 'owner@example.test', 'Owner',
       'human:owner@example.test', 'human', 'owner', 'active', '[]', 1),
      ('self-hosted', 'ws_1', 'room_1', 'owner@example.test', 'Writer',
       'agent:writer', 'agent', 'agent', 'active', '[]', 1);`);
    sqlite.prepare(`INSERT INTO collaboration_handoffs (
      handoff_id, tenant_id, workspace_id, room_id, task_id, sender_user_id, sender_actor_id,
      recipient_user_id, recipient_actor_id, root_handoff_id, depth, ancestor_handoff_ids_json,
      remaining_budget, granted_capabilities_json, status, created_at, executor_agent_name
    ) VALUES ('handoff_1', 'self-hosted', 'ws_1', 'room_1', 'task_1', 'owner@example.test',
      'human:owner@example.test', 'owner@example.test', 'agent:writer', 'handoff_1', 0, '[]',
      0, '[]', 'active', 1, 'isolated-executor')`).run();
    expect(sqlite.prepare("SELECT executor_agent_name FROM collaboration_handoffs").get())
      .toMatchObject({ executor_agent_name: "isolated-executor" });
    const insert = sqlite.prepare(`INSERT INTO collaboration_messages (
      message_id, tenant_id, workspace_id, room_id, sender_user_id, sender_actor_id,
      sender_kind, body, created_at, source_run_id, source_slack_team_id, source_slack_event_id
    ) VALUES (?, 'self-hosted', 'ws_1', 'room_1', 'owner@example.test',
      'human:owner@example.test', 'human', 'Result', 1, ?, ?, ?)`);
    insert.run("message_1", "run_1", "team_1", "event_1");
    expect(() => insert.run("message_2", "run_1", null, null)).toThrow(/UNIQUE/);
    expect(() => insert.run("message_3", null, "team_1", "event_1")).toThrow(/UNIQUE/);
  } finally {
    sqlite.close();
  }
});
