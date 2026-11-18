import { describe, expect, it } from "vitest";
import { applyAllMigrations } from "./fixtures/all-migrations.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

describe("D1 schema upgrade preservation", () => {
  it.each([false, true])("preserves onboarding rows when draft columns already exist: %s", (hasDraft) => {
    const { sqlite } = customAgentD1({ bare: true });
    try {
      applyAllMigrations(sqlite, 60);
      if (hasDraft) {
        sqlite.exec("ALTER TABLE user_onboarding_progress ADD COLUMN draft_task_id TEXT");
        sqlite.exec("ALTER TABLE user_onboarding_progress ADD COLUMN draft_task_json TEXT");
      }
      sqlite.exec(`INSERT INTO user_onboarding_progress
        (user_id,current_step,revision,created_at,updated_at)
        VALUES ('preserved-user','employee',7,10,20)`);
      if (hasDraft) sqlite.exec(`UPDATE user_onboarding_progress SET
        draft_task_id='goal-1', draft_task_json='{"goal":"Preserved task"}',
        accepted_artifact_at=30,activated_at=40`);
      applyAllMigrations(sqlite);
      const row = sqlite.prepare("SELECT * FROM user_onboarding_progress WHERE user_id='preserved-user'").get();
      expect(row).toMatchObject({ user_id: "preserved-user", current_step: "employee", revision: 7, created_at: 10, updated_at: 20,
        draft_task_id: hasDraft ? "goal-1" : null,
        draft_task_json: hasDraft ? '{"goal":"Preserved task"}' : null,
        accepted_artifact_at: hasDraft ? 30 : null,
        activated_at: hasDraft ? 40 : null,
      });
    } finally { sqlite.close(); }
  });
  it.each([false, true])("preserves handoff rows and existing executor pins: %s", (hasExecutor) => {
    const { sqlite } = customAgentD1({ bare: true });
    try {
      applyAllMigrations(sqlite, 60);
      if (hasExecutor) sqlite.exec("ALTER TABLE collaboration_handoffs ADD COLUMN executor_agent_name TEXT");
      sqlite.exec(`INSERT INTO collaboration_rooms
        (room_id,tenant_id,workspace_id,title,visibility,created_by_user_id,created_at)
        VALUES ('room-1','self-hosted','workspace-1','Preserved room','private','owner',1);
        INSERT INTO collaboration_memberships
        (tenant_id,workspace_id,room_id,user_id,display_name,actor_id,actor_kind,role,status,capabilities_json,created_at)
        VALUES ('self-hosted','workspace-1','room-1','owner','Owner','human:owner','human','owner','active','[]',1),
          ('self-hosted','workspace-1','room-1','owner','Writer','agent:writer','agent','agent','active','[]',1);`);
      sqlite.exec(`INSERT INTO collaboration_handoffs (
        handoff_id,tenant_id,workspace_id,room_id,task_id,sender_user_id,sender_actor_id,
        recipient_user_id,recipient_actor_id,root_handoff_id,depth,ancestor_handoff_ids_json,
        remaining_budget,granted_capabilities_json,status,created_at
      ) VALUES ('handoff-1','self-hosted','workspace-1','room-1','task-1','owner','human:owner',
        'owner','agent:writer','handoff-1',0,'[]',1,'[]','active',10)`);
      sqlite.exec(`INSERT INTO collaboration_handoffs (
        handoff_id,tenant_id,workspace_id,room_id,task_id,sender_user_id,sender_actor_id,
        recipient_user_id,recipient_actor_id,parent_handoff_id,root_handoff_id,depth,ancestor_handoff_ids_json,
        remaining_budget,granted_capabilities_json,status,created_at
      ) VALUES ('handoff-child','self-hosted','workspace-1','room-1','task-1','owner','human:owner',
        'owner','agent:writer','handoff-1','handoff-1',1,'["handoff-1"]',0,'[]','active',11)`);
      if (hasExecutor) sqlite.exec("UPDATE collaboration_handoffs SET executor_agent_name='pinned-executor'");
      applyAllMigrations(sqlite);
      expect(sqlite.prepare("SELECT handoff_id,remaining_budget,created_at,executor_agent_name FROM collaboration_handoffs WHERE handoff_id='handoff-1'").get())
        .toEqual({ handoff_id: "handoff-1", remaining_budget: 1, created_at: 10,
          executor_agent_name: hasExecutor ? "pinned-executor" : null });
      expect(sqlite.prepare("SELECT parent_handoff_id,root_handoff_id,depth FROM collaboration_handoffs WHERE handoff_id='handoff-child'").get())
        .toEqual({ parent_handoff_id: "handoff-1", root_handoff_id: "handoff-1", depth: 1 });
      expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { sqlite.close(); }
  });
});


it.each(["queued", "claimed"])("preserves legacy %s operation dispatch during rebuild", (state) => {
  const { sqlite } = customAgentD1({ bare: true });
  try {
    applyAllMigrations(sqlite, 60);
    sqlite.exec(`CREATE TABLE reason_network_operations (
      owner_id TEXT NOT NULL, grant_id TEXT NOT NULL, conversation_id TEXT NOT NULL, session_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL, payload_digest TEXT NOT NULL, destination TEXT NOT NULL,
      state TEXT NOT NULL, remote_message_id TEXT, updated_at INTEGER NOT NULL,
      PRIMARY KEY(owner_id,grant_id,conversation_id,session_id,idempotency_key)
    )`);
    sqlite.prepare("INSERT INTO reason_network_operations VALUES ('owner','grant','conversation','session','key','digest','peer',?,NULL,123)").run(state);
    applyAllMigrations(sqlite);
    expect(sqlite.prepare("SELECT state,dispatch_state,first_attempt_at FROM reason_network_operations").get())
      .toEqual({ state: "approved", dispatch_state: state, first_attempt_at: state === "claimed" ? 123 : null });
  } finally { sqlite.close(); }
});
