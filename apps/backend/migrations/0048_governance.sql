CREATE TABLE IF NOT EXISTS workspace_groups (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  name TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, group_id)
);

CREATE INDEX IF NOT EXISTS workspace_groups_workspace ON workspace_groups(tenant_id, workspace_id, created_at);

CREATE TABLE IF NOT EXISTS workspace_group_members (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  joined_at INTEGER NOT NULL,
  removed_at INTEGER,
  PRIMARY KEY (tenant_id, workspace_id, group_id, user_id),
  FOREIGN KEY (tenant_id, workspace_id, group_id) REFERENCES workspace_groups(tenant_id, workspace_id, group_id)
);

CREATE INDEX IF NOT EXISTS workspace_group_members_user ON workspace_group_members(tenant_id, workspace_id, user_id, removed_at);

CREATE TABLE IF NOT EXISTS workspace_resource_grants (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  resource_kind TEXT NOT NULL CHECK(resource_kind IN ('room', 'file', 'note', 'task', 'chat')),
  resource_id TEXT NOT NULL,
  principal_kind TEXT NOT NULL CHECK(principal_kind IN ('user', 'group', 'guest')),
  principal_id TEXT NOT NULL,
  access TEXT NOT NULL CHECK(access IN ('view', 'comment', 'edit', 'manage')),
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  revoked_at INTEGER,
  PRIMARY KEY (tenant_id, workspace_id, grant_id)
);

CREATE INDEX IF NOT EXISTS workspace_resource_grants_lookup
  ON workspace_resource_grants(tenant_id, workspace_id, resource_kind, resource_id, revoked_at);

CREATE INDEX IF NOT EXISTS workspace_resource_grants_principal
  ON workspace_resource_grants(tenant_id, workspace_id, principal_kind, principal_id, revoked_at);

CREATE TABLE IF NOT EXISTS workspace_guests (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  guest_id TEXT NOT NULL,
  email TEXT NOT NULL,
  invited_by TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER,
  accepted_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, guest_id)
);

CREATE INDEX IF NOT EXISTS workspace_guests_email ON workspace_guests(tenant_id, workspace_id, email, revoked_at);

CREATE TABLE IF NOT EXISTS workspace_sharing_policy (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL PRIMARY KEY,
  public_links_allowed INTEGER NOT NULL CHECK(public_links_allowed IN (0, 1)),
  guest_invites_allowed INTEGER NOT NULL CHECK(guest_invites_allowed IN (0, 1)),
  default_resource_access TEXT CHECK(default_resource_access IN ('view', 'comment', 'edit', 'manage')),
  version INTEGER NOT NULL CHECK(version > 0),
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS share_links (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  link_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  resource_kind TEXT NOT NULL CHECK(resource_kind IN ('room', 'file', 'note', 'task', 'chat')),
  resource_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  PRIMARY KEY (tenant_id, workspace_id, link_id)
);

CREATE INDEX IF NOT EXISTS share_links_resource ON share_links(tenant_id, workspace_id, resource_kind, resource_id, revoked_at);