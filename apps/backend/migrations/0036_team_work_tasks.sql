-- Workspace-owned tasks created from the Work view; handoff-derived items stay projections.
CREATE TABLE IF NOT EXISTS team_work_tasks (
    tenant_id TEXT NOT NULL,workspace_id TEXT NOT NULL,task_id TEXT NOT NULL,title TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('backlog','todo','in-progress','in-review','done','cancelled')),
    priority TEXT NOT NULL CHECK(priority IN ('none','low','medium','high','urgent')),
    owner_id TEXT,reviewer_id TEXT,start_date TEXT,end_date TEXT,parent_id TEXT,blocked INTEGER NOT NULL DEFAULT 0,objective TEXT,
    waiting_on_json TEXT NOT NULL DEFAULT '[]',context_json TEXT NOT NULL DEFAULT '[]',done_when_json TEXT NOT NULL DEFAULT '[]',
    activity_json TEXT NOT NULL DEFAULT '[]',archived INTEGER NOT NULL DEFAULT 0,created_by TEXT NOT NULL,
    version INTEGER NOT NULL CHECK(version>0),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
    PRIMARY KEY(tenant_id,workspace_id,task_id));

CREATE INDEX IF NOT EXISTS team_work_tasks_open ON team_work_tasks(tenant_id,workspace_id,archived,updated_at);
