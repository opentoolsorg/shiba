PRAGMA defer_foreign_keys=ON;

-- Freeze request-time D1 schema. Existing objects and data are retained.

CREATE INDEX IF NOT EXISTS audit_log_ts ON audit_log(ts);

CREATE INDEX IF NOT EXISTS audit_log_principal_ts ON audit_log(principal, ts);

CREATE TABLE IF NOT EXISTS collaboration_context_snapshots (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, room_id TEXT NOT NULL,
    handoff_id TEXT PRIMARY KEY, snapshot_json TEXT NOT NULL, approval_id TEXT, approved_task_sha256 TEXT,
    FOREIGN KEY(room_id) REFERENCES collaboration_rooms(room_id) ON DELETE CASCADE
  );

CREATE TABLE IF NOT EXISTS collaboration_memory (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, room_id TEXT NOT NULL,
    context_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version=1),
    title TEXT NOT NULL, content TEXT NOT NULL, sha256 TEXT NOT NULL,
    created_by_user_id TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER,
    PRIMARY KEY(tenant_id,workspace_id,room_id,context_id),
    FOREIGN KEY(room_id) REFERENCES collaboration_rooms(room_id) ON DELETE CASCADE
  );

CREATE UNIQUE INDEX IF NOT EXISTS collaboration_messages_source_run ON collaboration_messages(tenant_id,workspace_id,source_run_id) WHERE source_run_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS collaboration_messages_slack_event ON collaboration_messages(tenant_id,workspace_id,source_slack_team_id,source_slack_event_id) WHERE source_slack_event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS org_custom_agents (
     id TEXT PRIMARY KEY,
     org_id TEXT NOT NULL,
     slug TEXT NOT NULL,
     version INTEGER NOT NULL,
     config_json TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     deleted_at INTEGER,
     archived_at INTEGER
   );



CREATE TABLE IF NOT EXISTS org_custom_agent_versions (
     agent_id TEXT NOT NULL,
     org_id TEXT NOT NULL,
     version INTEGER NOT NULL,
     config_json TEXT NOT NULL,
     saved_at INTEGER NOT NULL,
     PRIMARY KEY (agent_id, version)
   );

CREATE TABLE IF NOT EXISTS employee_bundle_profile_owners (
      org_id TEXT NOT NULL, employee_id TEXT NOT NULL, owner_id TEXT NOT NULL,
      PRIMARY KEY (org_id, employee_id));

CREATE TABLE IF NOT EXISTS employee_bundle_previews (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL, owner_id TEXT NOT NULL,
      digest TEXT NOT NULL, recipe_json TEXT NOT NULL, expires_at INTEGER NOT NULL,
      consumed_import_id TEXT);

CREATE TABLE IF NOT EXISTS employee_bundle_imports (
      org_id TEXT NOT NULL, owner_id TEXT NOT NULL, import_id TEXT NOT NULL,
      preview_id TEXT NOT NULL UNIQUE, digest TEXT NOT NULL, employee_id TEXT NOT NULL,
      recipe_json TEXT NOT NULL, result_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (org_id, owner_id, import_id));

CREATE TABLE IF NOT EXISTS employee_tool_memberships (
    org_id TEXT NOT NULL,
    employee_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('owner','admin','operator','member','viewer')),
    employee_version INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT NOT NULL,
    PRIMARY KEY(org_id, employee_id, actor_id)
  );

CREATE TABLE IF NOT EXISTS employee_tool_grants (
    org_id TEXT NOT NULL,
    employee_id TEXT NOT NULL,
    employee_version INTEGER NOT NULL,
    subject_type TEXT NOT NULL CHECK(subject_type IN ('workspace','actor','role')),
    subject_id TEXT NOT NULL,
    capability_id TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    lifecycle TEXT NOT NULL CHECK(lifecycle IN ('active','revoked','expired')),
    provider_scopes_json TEXT NOT NULL,
    account_id TEXT,
    policy_version TEXT NOT NULL,
    generation INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(org_id, employee_id, employee_version, subject_type, subject_id, capability_id, resource_id)
  );

CREATE INDEX IF NOT EXISTS employee_tool_grants_lookup
    ON employee_tool_grants(org_id, employee_id, employee_version, lifecycle, capability_id);

CREATE TABLE IF NOT EXISTS employee_tool_approvals (
    employee_context_json TEXT,
    decision_owner_account_id TEXT,
    approval_id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    employee_id TEXT NOT NULL,
    employee_version INTEGER NOT NULL,
    actor_id TEXT NOT NULL,
    execution_context_id TEXT,
    consumed_at INTEGER,
    consumed_invocation_id TEXT,
    connection_id TEXT NOT NULL,
    connection_generation INTEGER NOT NULL,
    capability_kind TEXT NOT NULL,
    capability_id TEXT NOT NULL,
    action TEXT NOT NULL,
    resource_id TEXT,
    account_id TEXT,
    argument_digest TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','approved','denied','expired')),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    decided_by TEXT,
    decided_at INTEGER
  );





CREATE TABLE IF NOT EXISTS gmail_oauth_states (
    state_hash TEXT PRIMARY KEY, owner TEXT NOT NULL UNIQUE,
    verifier TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0
  );

CREATE INDEX IF NOT EXISTS gmail_states_expiry ON gmail_oauth_states(expires_at);

CREATE TABLE IF NOT EXISTS gmail_resource_candidates (
    owner TEXT NOT NULL, connection_id TEXT NOT NULL, message_id TEXT NOT NULL, thread_id TEXT NOT NULL,
    sender TEXT NOT NULL DEFAULT '', subject TEXT NOT NULL DEFAULT '', date TEXT NOT NULL DEFAULT '',
    expires_at INTEGER NOT NULL, PRIMARY KEY(owner, connection_id, message_id)
  );

CREATE INDEX IF NOT EXISTS gmail_resource_candidates_expiry ON gmail_resource_candidates(expires_at);

CREATE TABLE IF NOT EXISTS gmail_connections (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL UNIQUE, email TEXT NOT NULL,
    refresh_cipher TEXT NOT NULL, created_at INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1))
  );

CREATE TABLE IF NOT EXISTS gmail_grants (
    principal TEXT NOT NULL, owner TEXT NOT NULL, connection_id TEXT NOT NULL,
    created_at INTEGER NOT NULL, token_created INTEGER NOT NULL, PRIMARY KEY (principal, token_created),
    FOREIGN KEY(connection_id) REFERENCES gmail_connections(id) ON DELETE CASCADE
  );

CREATE TABLE IF NOT EXISTS org_sandbox_settings (
     org_id TEXT PRIMARY KEY,
     provider_id TEXT NOT NULL,
     computesdk_backend TEXT,
     runner_url TEXT,
     updated_at INTEGER NOT NULL
   );

CREATE TABLE IF NOT EXISTS org_secrets (
     org_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     name TEXT NOT NULL,
     cipher TEXT NOT NULL,
     last4 TEXT NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (org_id, kind, name)
   );

CREATE TABLE IF NOT EXISTS user_openai_auth_mode (
    user_id TEXT PRIMARY KEY,
    mode TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

CREATE TABLE IF NOT EXISTS user_subscription_credentials (
    workspace_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    auth_cipher TEXT NOT NULL,
    account_email_hash TEXT,
    expires_at INTEGER,
    saved_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, user_id, kind)
  );

CREATE INDEX IF NOT EXISTS team_workspace_memberships_user ON team_workspace_memberships(tenant_id,user_id,status);

CREATE TABLE IF NOT EXISTS team_workspace_invitations (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, invitation_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE, email TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','admin','member')),
    issuer_user_id TEXT NOT NULL, issuer_version INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','accepted','revoked')),
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, accepted_by_user_id TEXT, accepted_at INTEGER, revoked_at INTEGER,
    PRIMARY KEY(tenant_id,workspace_id,invitation_id),
    FOREIGN KEY(tenant_id,workspace_id) REFERENCES team_workspaces(tenant_id,workspace_id));

CREATE TABLE IF NOT EXISTS reason_network_operations (
    owner_id TEXT NOT NULL, grant_id TEXT NOT NULL, conversation_id TEXT NOT NULL, session_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL, payload_digest TEXT NOT NULL, destination TEXT NOT NULL,
    operation_id TEXT NOT NULL, approval_id TEXT, companion_machine_id TEXT, claim_token TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0, first_attempt_at INTEGER, dispatch_state TEXT, cancelled_at INTEGER,
    state TEXT NOT NULL CHECK (state IN ('pending_approval','approved','accepted','unknown','rejected','cancelled')), remote_message_id TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(owner_id, grant_id, conversation_id, session_id, idempotency_key)
  );

CREATE TABLE IF NOT EXISTS reason_network_grants (
    grant_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, conversation_id TEXT NOT NULL, session_id TEXT NOT NULL,
    companion_machine_id TEXT,
    status TEXT NOT NULL CHECK(status IN ('active','revoked')), created_at INTEGER NOT NULL, revoked_at INTEGER
  );



CREATE TABLE IF NOT EXISTS reason_network_approvals (
    approval_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, grant_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
    session_id TEXT NOT NULL, destination TEXT NOT NULL, message TEXT NOT NULL, idempotency_key TEXT NOT NULL,
    reply_to TEXT, payload_digest TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','approved','denied','consumed','expired')),
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, decided_by TEXT, decided_at INTEGER,
    FOREIGN KEY(grant_id) REFERENCES reason_network_grants(grant_id)
  );

CREATE INDEX IF NOT EXISTS reason_network_approvals_pending ON reason_network_approvals(owner_id,status,created_at DESC);

CREATE TABLE IF NOT EXISTS shiba_auth_bootstrap_challenges (
  token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, email TEXT NOT NULL, nonce TEXT NOT NULL UNIQUE, origin TEXT NOT NULL,
  expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, consumed_at INTEGER);

INSERT OR IGNORE INTO shiba_auth_account_policy(account_id,email,kind)
      SELECT id,lower(trim(email)),'bootstrap' FROM "user"
      WHERE (SELECT COUNT(*) FROM "user")=1
      AND NOT EXISTS(SELECT 1 FROM shiba_auth_policy_migrations WHERE migration_id='legacy-bootstrap-v1');

INSERT OR IGNORE INTO shiba_auth_policy_migrations(migration_id) VALUES('legacy-bootstrap-v1');

-- Preserve prior rows whether or not the old Worker added optional columns.

CREATE TABLE IF NOT EXISTS user_onboarding_progress_ar01 (
  user_id TEXT PRIMARY KEY,
  current_step TEXT NOT NULL DEFAULT 'channels' CHECK (current_step IN ('channels','agent','models','employee')),
  dismissed_at INTEGER,
  connection_verified_at INTEGER,
  first_successful_run_at INTEGER,
  accepted_artifact_at INTEGER,
  activated_at INTEGER,
  revision INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
,
  draft_task_id TEXT,
  draft_task_json TEXT
);

INSERT INTO user_onboarding_progress_ar01 ("user_id","current_step","dismissed_at","connection_verified_at","first_successful_run_at","accepted_artifact_at","activated_at","revision","created_at","updated_at","draft_task_id","draft_task_json") SELECT "user_id","current_step","dismissed_at","connection_verified_at","first_successful_run_at","accepted_artifact_at","activated_at","revision","created_at","updated_at","draft_task_id","draft_task_json" FROM (SELECT *, NULL AS "accepted_artifact_at",NULL AS "draft_task_id",NULL AS "draft_task_json" FROM user_onboarding_progress);

DROP TABLE user_onboarding_progress;

ALTER TABLE user_onboarding_progress_ar01 RENAME TO user_onboarding_progress;

-- Preserve prior rows whether or not the old Worker added optional columns.

CREATE TABLE IF NOT EXISTS collaboration_handoffs_ar01 (
    handoff_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    room_id TEXT NOT NULL REFERENCES collaboration_rooms(room_id) ON DELETE CASCADE,
    task_id TEXT NOT NULL,
    sender_user_id TEXT NOT NULL,
    sender_actor_id TEXT NOT NULL,
    recipient_user_id TEXT NOT NULL,
    recipient_actor_id TEXT NOT NULL,
    parent_handoff_id TEXT,
    root_handoff_id TEXT NOT NULL,
    depth INTEGER NOT NULL CHECK (depth BETWEEN 0 AND 4),
    ancestor_handoff_ids_json TEXT NOT NULL,
    remaining_budget INTEGER NOT NULL CHECK (remaining_budget BETWEEN 0 AND 32),
    granted_capabilities_json TEXT NOT NULL,
    profile_version INTEGER,
    status TEXT NOT NULL CHECK (status IN ('active','cancelled')),
    created_at INTEGER NOT NULL,
    cancelled_at INTEGER,
    approval_id TEXT,
    run_id TEXT,
    executor_agent_name TEXT,
  FOREIGN KEY (tenant_id, workspace_id, room_id, sender_actor_id)
      REFERENCES collaboration_memberships(tenant_id, workspace_id, room_id, actor_id),
    FOREIGN KEY (tenant_id, workspace_id, room_id, recipient_actor_id)
      REFERENCES collaboration_memberships(tenant_id, workspace_id, room_id, actor_id),
    FOREIGN KEY (tenant_id, workspace_id, parent_handoff_id)
      REFERENCES collaboration_handoffs_ar01(tenant_id, workspace_id, handoff_id),
    PRIMARY KEY (tenant_id, workspace_id, handoff_id)
  );

INSERT INTO collaboration_handoffs_ar01 ("handoff_id","tenant_id","workspace_id","room_id","task_id","sender_user_id","sender_actor_id","recipient_user_id","recipient_actor_id","parent_handoff_id","root_handoff_id","depth","ancestor_handoff_ids_json","remaining_budget","granted_capabilities_json","profile_version","status","created_at","cancelled_at","approval_id","run_id","executor_agent_name") SELECT "handoff_id","tenant_id","workspace_id","room_id","task_id","sender_user_id","sender_actor_id","recipient_user_id","recipient_actor_id","parent_handoff_id","root_handoff_id","depth","ancestor_handoff_ids_json","remaining_budget","granted_capabilities_json","profile_version","status","created_at","cancelled_at","approval_id","run_id","executor_agent_name" FROM (SELECT *, NULL AS "executor_agent_name" FROM collaboration_handoffs);

DROP TABLE collaboration_handoffs;

ALTER TABLE collaboration_handoffs_ar01 RENAME TO collaboration_handoffs;

CREATE INDEX IF NOT EXISTS collaboration_handoffs_parent ON collaboration_handoffs(tenant_id, workspace_id, room_id, parent_handoff_id, created_at);

UPDATE user_onboarding_progress SET accepted_artifact_at=NULL,activated_at=NULL,revision=revision+1
WHERE draft_task_id IS NULL AND (accepted_artifact_at IS NOT NULL OR activated_at IS NOT NULL);

-- Retain fields from current Workers and fill columns absent in older installs.
CREATE TABLE IF NOT EXISTS org_custom_agents_ar01 (
     id TEXT PRIMARY KEY,
     org_id TEXT NOT NULL,
     slug TEXT NOT NULL,
     version INTEGER NOT NULL,
     config_json TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     deleted_at INTEGER,
     archived_at INTEGER
   );
INSERT INTO org_custom_agents_ar01 ("id","org_id","slug","version","config_json","created_at","updated_at","deleted_at","archived_at") SELECT "id","org_id","slug","version","config_json","created_at","updated_at","deleted_at","archived_at" FROM (SELECT *, NULL AS "archived_at" FROM org_custom_agents);
DROP TABLE org_custom_agents;
ALTER TABLE org_custom_agents_ar01 RENAME TO org_custom_agents;
CREATE UNIQUE INDEX IF NOT EXISTS org_custom_agents_org_slug ON org_custom_agents(org_id, slug);

-- Retain fields from current Workers and fill columns absent in older installs.
CREATE TABLE IF NOT EXISTS org_sandbox_settings_ar01 (
     org_id TEXT PRIMARY KEY,
     provider_id TEXT NOT NULL,
     computesdk_backend TEXT,
     runner_url TEXT,
     updated_at INTEGER NOT NULL
   );
INSERT INTO org_sandbox_settings_ar01 ("org_id","provider_id","computesdk_backend","runner_url","updated_at") SELECT "org_id","provider_id","computesdk_backend","runner_url","updated_at" FROM (SELECT *, NULL AS "runner_url" FROM org_sandbox_settings);
DROP TABLE org_sandbox_settings;
ALTER TABLE org_sandbox_settings_ar01 RENAME TO org_sandbox_settings;

-- Retain fields from current Workers and fill columns absent in older installs.
CREATE TABLE IF NOT EXISTS employee_tool_approvals_ar01 (
    employee_context_json TEXT,
    decision_owner_account_id TEXT,
    approval_id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    employee_id TEXT NOT NULL,
    employee_version INTEGER NOT NULL,
    actor_id TEXT NOT NULL,
    execution_context_id TEXT,
    consumed_at INTEGER,
    consumed_invocation_id TEXT,
    connection_id TEXT NOT NULL,
    connection_generation INTEGER NOT NULL,
    capability_kind TEXT NOT NULL,
    capability_id TEXT NOT NULL,
    action TEXT NOT NULL,
    resource_id TEXT,
    account_id TEXT,
    argument_digest TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','approved','denied','expired')),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    decided_by TEXT,
    decided_at INTEGER
  );
INSERT INTO employee_tool_approvals_ar01 ("employee_context_json","decision_owner_account_id","approval_id","org_id","employee_id","employee_version","actor_id","execution_context_id","consumed_at","consumed_invocation_id","connection_id","connection_generation","capability_kind","capability_id","action","resource_id","account_id","argument_digest","payload_json","policy_version","status","created_at","expires_at","decided_by","decided_at") SELECT "employee_context_json","decision_owner_account_id","approval_id","org_id","employee_id","employee_version","actor_id","execution_context_id","consumed_at","consumed_invocation_id","connection_id","connection_generation","capability_kind","capability_id","action","resource_id","account_id","argument_digest","payload_json","policy_version","status","created_at","expires_at","decided_by","decided_at" FROM (SELECT *, NULL AS "execution_context_id",NULL AS "consumed_at",NULL AS "consumed_invocation_id",NULL AS "employee_context_json",NULL AS "decision_owner_account_id" FROM employee_tool_approvals);
DROP TABLE employee_tool_approvals;
ALTER TABLE employee_tool_approvals_ar01 RENAME TO employee_tool_approvals;
CREATE INDEX IF NOT EXISTS employee_tool_approvals_pending
    ON employee_tool_approvals(org_id, status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS employee_tool_approval_active_payload_v2
    ON employee_tool_approvals(org_id, employee_id, employee_version, actor_id, IFNULL(execution_context_id, ''), capability_id, action,
      argument_digest, IFNULL(resource_id, ''), connection_generation)
    WHERE status IN ('pending','approved');

-- Retain fields from current Workers and fill columns absent in older installs.
CREATE TABLE IF NOT EXISTS reason_network_grants_ar01 (
    grant_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, conversation_id TEXT NOT NULL, session_id TEXT NOT NULL,
    companion_machine_id TEXT,
    status TEXT NOT NULL CHECK(status IN ('active','revoked')), created_at INTEGER NOT NULL, revoked_at INTEGER
  );
INSERT INTO reason_network_grants_ar01 ("grant_id","owner_id","conversation_id","session_id","companion_machine_id","status","created_at","revoked_at") SELECT "grant_id","owner_id","conversation_id","session_id","companion_machine_id","status","created_at","revoked_at" FROM (SELECT *, NULL AS "companion_machine_id" FROM reason_network_grants);
DROP TABLE reason_network_grants;
ALTER TABLE reason_network_grants_ar01 RENAME TO reason_network_grants;
CREATE INDEX IF NOT EXISTS reason_network_grants_owner ON reason_network_grants(owner_id,status,conversation_id,session_id);

-- Retain fields from current Workers and fill columns absent in older installs.
CREATE TABLE IF NOT EXISTS reason_network_operations_ar01 (
    owner_id TEXT NOT NULL, grant_id TEXT NOT NULL, conversation_id TEXT NOT NULL, session_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL, payload_digest TEXT NOT NULL, destination TEXT NOT NULL,
    operation_id TEXT NOT NULL, approval_id TEXT, companion_machine_id TEXT, claim_token TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0, first_attempt_at INTEGER, dispatch_state TEXT, cancelled_at INTEGER,
    state TEXT NOT NULL CHECK (state IN ('pending_approval','approved','accepted','unknown','rejected','cancelled')), remote_message_id TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(owner_id, grant_id, conversation_id, session_id, idempotency_key)
  );
INSERT INTO reason_network_operations_ar01 ("owner_id","grant_id","conversation_id","session_id","idempotency_key","payload_digest","destination","operation_id","approval_id","companion_machine_id","claim_token","cancel_requested","first_attempt_at","dispatch_state","cancelled_at","state","remote_message_id","updated_at") SELECT "owner_id","grant_id","conversation_id","session_id","idempotency_key","payload_digest","destination",COALESCE("operation_id",'rno-legacy-'||lower(hex(randomblob(16)))),"approval_id","companion_machine_id","claim_token","cancel_requested","first_attempt_at",CASE WHEN "state" IN ('queued','claimed') AND "dispatch_state" IS NULL THEN "state" ELSE "dispatch_state" END,"cancelled_at",CASE WHEN "state" IN ('queued','claimed') AND "dispatch_state" IS NULL THEN 'approved' ELSE "state" END,"remote_message_id","updated_at" FROM (SELECT *, NULL AS "operation_id",NULL AS "approval_id",NULL AS "companion_machine_id",NULL AS "claim_token",0 AS "cancel_requested",NULL AS "first_attempt_at",NULL AS "dispatch_state",NULL AS "cancelled_at" FROM reason_network_operations);
DROP TABLE reason_network_operations;
ALTER TABLE reason_network_operations_ar01 RENAME TO reason_network_operations;


UPDATE reason_network_operations SET operation_id='rno-legacy-'||lower(hex(randomblob(16))) WHERE operation_id IS NULL;

UPDATE reason_network_operations SET dispatch_state=state,state='approved' WHERE state IN ('queued','claimed') AND dispatch_state IS NULL;

UPDATE reason_network_operations SET first_attempt_at=CASE WHEN state='unknown' THEN 0 WHEN dispatch_state='claimed' THEN updated_at ELSE NULL END WHERE first_attempt_at IS NULL AND (state='unknown' OR dispatch_state='claimed');

UPDATE reason_network_operations SET cancelled_at=COALESCE(cancelled_at,updated_at),dispatch_state=NULL WHERE dispatch_state='cancelled';

CREATE UNIQUE INDEX IF NOT EXISTS reason_network_operations_operation_id ON reason_network_operations(operation_id);

DROP INDEX IF EXISTS employee_tool_approval_active_payload;
