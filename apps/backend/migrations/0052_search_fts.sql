-- WS08: workspace-scoped FTS index for tasks, collaboration rooms/messages, run titles.
CREATE TABLE IF NOT EXISTS workspace_search_docs (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('task','room','message','run')),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, doc_id)
);

CREATE INDEX IF NOT EXISTS workspace_search_docs_kind
  ON workspace_search_docs(tenant_id, workspace_id, kind, updated_at);

CREATE VIRTUAL TABLE IF NOT EXISTS workspace_search_fts USING fts5(
  title, body,
  content='workspace_search_docs',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS workspace_search_fts_ai AFTER INSERT ON workspace_search_docs BEGIN
  INSERT INTO workspace_search_fts(rowid, title, body)
  VALUES (new.rowid, new.title, new.body);
END;

CREATE TRIGGER IF NOT EXISTS workspace_search_fts_ad AFTER DELETE ON workspace_search_docs BEGIN
  INSERT INTO workspace_search_fts(workspace_search_fts, rowid, title, body)
  VALUES('delete', old.rowid, old.title, old.body);
END;

CREATE TRIGGER IF NOT EXISTS workspace_search_fts_au AFTER UPDATE ON workspace_search_docs BEGIN
  INSERT INTO workspace_search_fts(workspace_search_fts, rowid, title, body)
  VALUES('delete', old.rowid, old.title, old.body);
  INSERT INTO workspace_search_fts(rowid, title, body)
  VALUES (new.rowid, new.title, new.body);
END;