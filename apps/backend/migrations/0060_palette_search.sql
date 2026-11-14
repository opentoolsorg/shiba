-- Palette search. Base room tables match the collaboration migration's opening
-- section so a fresh database works whichever file lands first.

CREATE TABLE IF NOT EXISTS collaboration_rooms (
    room_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    title TEXT NOT NULL,
    visibility TEXT NOT NULL CHECK (visibility IN ('private','shared')),
    created_by_user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

CREATE INDEX IF NOT EXISTS collaboration_rooms_scope ON collaboration_rooms(tenant_id, workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS collaboration_memberships (
    tenant_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    room_id TEXT NOT NULL REFERENCES collaboration_rooms(room_id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human','agent')),
    role TEXT NOT NULL CHECK (role IN ('owner','member','agent')),
    status TEXT NOT NULL CHECK (status IN ('active','removed')),
    capabilities_json TEXT NOT NULL,
    profile_version INTEGER,
    created_at INTEGER NOT NULL,
    removed_at INTEGER,
    PRIMARY KEY (tenant_id, workspace_id, room_id, actor_id)
  );

CREATE INDEX IF NOT EXISTS collaboration_memberships_user ON collaboration_memberships(tenant_id, workspace_id, user_id, status, room_id);

CREATE TABLE IF NOT EXISTS collaboration_messages (
    message_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    room_id TEXT NOT NULL REFERENCES collaboration_rooms(room_id) ON DELETE CASCADE,
    sender_user_id TEXT NOT NULL,
    sender_actor_id TEXT NOT NULL,
    sender_kind TEXT NOT NULL CHECK (sender_kind IN ('human','agent')),
    body TEXT NOT NULL,
    profile_version INTEGER,
    source_run_id TEXT,
    source_handoff_id TEXT,
    source_artifact_refs_json TEXT,
    source_slack_event_id TEXT,
    source_slack_team_id TEXT,
    source_slack_channel_id TEXT,
    source_slack_thread_ts TEXT,
    source_slack_user_id TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (tenant_id, workspace_id, room_id, sender_actor_id)
      REFERENCES collaboration_memberships(tenant_id, workspace_id, room_id, actor_id),
    PRIMARY KEY (tenant_id, workspace_id, message_id)
  );

CREATE INDEX IF NOT EXISTS collaboration_messages_room ON collaboration_messages(tenant_id, workspace_id, room_id, created_at, message_id);

ALTER TABLE workspace_search_docs ADD COLUMN room_id TEXT;
ALTER TABLE workspace_search_docs ADD COLUMN thread_root_id TEXT;
ALTER TABLE workspace_search_docs ADD COLUMN sender_actor_id TEXT;

CREATE INDEX IF NOT EXISTS workspace_search_docs_room
  ON workspace_search_docs(tenant_id, workspace_id, room_id);

CREATE TABLE IF NOT EXISTS bot_room_activity (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  last_message_id TEXT NOT NULL,
  preview TEXT NOT NULL,
  last_speaker_actor_id TEXT NOT NULL,
  last_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, actor_id, room_id)
);

CREATE TABLE IF NOT EXISTS palette_pins (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  slot INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 9),
  PRIMARY KEY (tenant_id, workspace_id, user_id, slot)
);

CREATE UNIQUE INDEX IF NOT EXISTS palette_pins_actor
  ON palette_pins(tenant_id, workspace_id, user_id, actor_id);

CREATE TRIGGER IF NOT EXISTS palette_search_message_ai AFTER INSERT ON collaboration_messages BEGIN
  INSERT INTO workspace_search_docs (
    tenant_id, workspace_id, doc_id, kind, title, body, updated_at, room_id, thread_root_id, sender_actor_id
  ) VALUES (
    NEW.tenant_id, NEW.workspace_id, NEW.room_id || ':' || NEW.message_id, 'message',
    COALESCE((SELECT title FROM collaboration_rooms r WHERE r.tenant_id = NEW.tenant_id AND r.workspace_id = NEW.workspace_id AND r.room_id = NEW.room_id), ''),
    substr(NEW.body, 1, 16000), NEW.created_at, NEW.room_id, NULL, NEW.sender_actor_id
  )
  ON CONFLICT(tenant_id, workspace_id, doc_id) DO UPDATE SET
    kind = excluded.kind, title = excluded.title, body = excluded.body, updated_at = excluded.updated_at,
    room_id = excluded.room_id, thread_root_id = excluded.thread_root_id, sender_actor_id = excluded.sender_actor_id;
END;

CREATE TRIGGER IF NOT EXISTS palette_search_message_au AFTER UPDATE OF body ON collaboration_messages BEGIN
  INSERT INTO workspace_search_docs (
    tenant_id, workspace_id, doc_id, kind, title, body, updated_at, room_id, thread_root_id, sender_actor_id
  ) VALUES (
    NEW.tenant_id, NEW.workspace_id, NEW.room_id || ':' || NEW.message_id, 'message',
    COALESCE((SELECT title FROM collaboration_rooms r WHERE r.tenant_id = NEW.tenant_id AND r.workspace_id = NEW.workspace_id AND r.room_id = NEW.room_id), ''),
    substr(NEW.body, 1, 16000), NEW.created_at, NEW.room_id, NULL, NEW.sender_actor_id
  )
  ON CONFLICT(tenant_id, workspace_id, doc_id) DO UPDATE SET
    kind = excluded.kind, title = excluded.title, body = excluded.body, updated_at = excluded.updated_at,
    room_id = excluded.room_id, thread_root_id = excluded.thread_root_id, sender_actor_id = excluded.sender_actor_id;
END;

CREATE TRIGGER IF NOT EXISTS palette_search_message_ad AFTER DELETE ON collaboration_messages BEGIN
  DELETE FROM workspace_search_docs
  WHERE tenant_id = OLD.tenant_id AND workspace_id = OLD.workspace_id
    AND doc_id = OLD.room_id || ':' || OLD.message_id;
  DELETE FROM bot_room_activity
  WHERE tenant_id = OLD.tenant_id AND workspace_id = OLD.workspace_id
    AND room_id = OLD.room_id AND last_message_id = OLD.message_id;
END;

CREATE TRIGGER IF NOT EXISTS palette_search_room_ai AFTER INSERT ON collaboration_rooms BEGIN
  INSERT INTO workspace_search_docs (
    tenant_id, workspace_id, doc_id, kind, title, body, updated_at, room_id, thread_root_id, sender_actor_id
  ) VALUES (
    NEW.tenant_id, NEW.workspace_id, NEW.room_id, 'room', NEW.title, substr(NEW.title, 1, 16000),
    NEW.created_at, NEW.room_id, NULL, NULL
  )
  ON CONFLICT(tenant_id, workspace_id, doc_id) DO UPDATE SET
    kind = excluded.kind, title = excluded.title, body = excluded.body, updated_at = excluded.updated_at,
    room_id = excluded.room_id;
END;

CREATE TRIGGER IF NOT EXISTS palette_search_room_au AFTER UPDATE OF title ON collaboration_rooms BEGIN
  INSERT INTO workspace_search_docs (
    tenant_id, workspace_id, doc_id, kind, title, body, updated_at, room_id, thread_root_id, sender_actor_id
  ) VALUES (
    NEW.tenant_id, NEW.workspace_id, NEW.room_id, 'room', NEW.title, substr(NEW.title, 1, 16000),
    NEW.created_at, NEW.room_id, NULL, NULL
  )
  ON CONFLICT(tenant_id, workspace_id, doc_id) DO UPDATE SET
    kind = excluded.kind, title = excluded.title, body = excluded.body, updated_at = excluded.updated_at,
    room_id = excluded.room_id;
END;

CREATE TRIGGER IF NOT EXISTS palette_search_room_ad AFTER DELETE ON collaboration_rooms BEGIN
  DELETE FROM workspace_search_docs
  WHERE tenant_id = OLD.tenant_id AND workspace_id = OLD.workspace_id AND doc_id = OLD.room_id AND kind = 'room';
END;

CREATE TRIGGER IF NOT EXISTS bot_room_activity_ai AFTER INSERT ON collaboration_messages
WHEN NEW.sender_kind = 'agent'
BEGIN
  INSERT INTO bot_room_activity (
    tenant_id, workspace_id, actor_id, room_id, last_message_id, preview, last_speaker_actor_id, last_at
  ) VALUES (
    NEW.tenant_id, NEW.workspace_id, NEW.sender_actor_id, NEW.room_id, NEW.message_id,
    substr(NEW.body, 1, 140), NEW.sender_actor_id, NEW.created_at
  )
  ON CONFLICT(tenant_id, workspace_id, actor_id, room_id) DO UPDATE SET
    last_message_id = excluded.last_message_id, preview = excluded.preview,
    last_speaker_actor_id = excluded.last_speaker_actor_id, last_at = excluded.last_at;
END;

-- A direct message is one active human and one active agent. Shared rooms stay out of this path.
CREATE TRIGGER IF NOT EXISTS bot_room_activity_dm_ai AFTER INSERT ON collaboration_messages
WHEN NEW.sender_kind = 'human'
BEGIN
  INSERT INTO bot_room_activity (
    tenant_id, workspace_id, actor_id, room_id, last_message_id, preview, last_speaker_actor_id, last_at
  )
  SELECT NEW.tenant_id, NEW.workspace_id, agent.actor_id, NEW.room_id, NEW.message_id,
         substr(NEW.body, 1, 140), NEW.sender_actor_id, NEW.created_at
  FROM collaboration_memberships agent
  WHERE agent.tenant_id = NEW.tenant_id AND agent.workspace_id = NEW.workspace_id AND agent.room_id = NEW.room_id
    AND agent.actor_kind = 'agent' AND agent.status = 'active'
    AND (SELECT COUNT(*) FROM collaboration_memberships h
         WHERE h.tenant_id = NEW.tenant_id AND h.workspace_id = NEW.workspace_id AND h.room_id = NEW.room_id
           AND h.status = 'active' AND h.actor_kind = 'human') = 1
    AND (SELECT COUNT(*) FROM collaboration_memberships a
         WHERE a.tenant_id = NEW.tenant_id AND a.workspace_id = NEW.workspace_id AND a.room_id = NEW.room_id
           AND a.status = 'active' AND a.actor_kind = 'agent') = 1
  ON CONFLICT(tenant_id, workspace_id, actor_id, room_id) DO UPDATE SET
    last_message_id = excluded.last_message_id, preview = excluded.preview,
    last_speaker_actor_id = excluded.last_speaker_actor_id, last_at = excluded.last_at;
END;

CREATE TRIGGER IF NOT EXISTS bot_room_activity_au AFTER UPDATE OF body ON collaboration_messages BEGIN
  UPDATE bot_room_activity
  SET preview = substr(NEW.body, 1, 140), last_speaker_actor_id = NEW.sender_actor_id
  WHERE tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id
    AND room_id = NEW.room_id AND last_message_id = NEW.message_id;
END;

-- backfill-start
INSERT INTO workspace_search_docs (
  tenant_id, workspace_id, doc_id, kind, title, body, updated_at, room_id, thread_root_id, sender_actor_id
)
SELECT m.tenant_id, m.workspace_id, m.room_id || ':' || m.message_id, 'message',
  COALESCE((SELECT r.title FROM collaboration_rooms r WHERE r.tenant_id = m.tenant_id AND r.workspace_id = m.workspace_id AND r.room_id = m.room_id), ''),
  substr(m.body, 1, 16000), m.created_at, m.room_id, NULL, m.sender_actor_id
FROM collaboration_messages m
WHERE NOT EXISTS (
  SELECT 1 FROM workspace_search_docs d
  WHERE d.tenant_id = m.tenant_id AND d.workspace_id = m.workspace_id AND d.doc_id = m.room_id || ':' || m.message_id
);

INSERT INTO workspace_search_docs (
  tenant_id, workspace_id, doc_id, kind, title, body, updated_at, room_id, thread_root_id, sender_actor_id
)
SELECT r.tenant_id, r.workspace_id, r.room_id, 'room', r.title, substr(r.title, 1, 16000),
  r.created_at, r.room_id, NULL, NULL
FROM collaboration_rooms r
WHERE NOT EXISTS (
  SELECT 1 FROM workspace_search_docs d
  WHERE d.tenant_id = r.tenant_id AND d.workspace_id = r.workspace_id AND d.doc_id = r.room_id
);

INSERT INTO bot_room_activity (
  tenant_id, workspace_id, actor_id, room_id, last_message_id, preview, last_speaker_actor_id, last_at
)
SELECT m.tenant_id, m.workspace_id, m.sender_actor_id, m.room_id, m.message_id,
  substr(m.body, 1, 140), m.sender_actor_id, m.created_at
FROM collaboration_messages m
WHERE m.sender_kind = 'agent'
  AND NOT EXISTS (
    SELECT 1 FROM collaboration_messages newer
    WHERE newer.tenant_id = m.tenant_id AND newer.workspace_id = m.workspace_id AND newer.room_id = m.room_id
      AND newer.sender_actor_id = m.sender_actor_id AND newer.sender_kind = 'agent'
      AND (newer.created_at > m.created_at OR (newer.created_at = m.created_at AND newer.message_id > m.message_id))
  )
ON CONFLICT(tenant_id, workspace_id, actor_id, room_id) DO UPDATE SET
  last_message_id = excluded.last_message_id, preview = excluded.preview,
  last_speaker_actor_id = excluded.last_speaker_actor_id, last_at = excluded.last_at;
-- backfill-end
