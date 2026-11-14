import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COLLAB_TENANT_ID } from "../src/collaboration-store.js";
import { searchWorkspace, upsertWorkspaceSearchDoc } from "../src/workspace-search-store.js";

const FILES = ["0036_team_work_tasks.sql", "0052_search_fts.sql", "0053_ask_user_and_claims.sql", "0060_palette_search.sql"];

function makeD1(): D1Database {
  const db = new DatabaseSync(":memory:");
  for (const file of FILES) db.exec(readFileSync(join(import.meta.dirname, "../migrations", file), "utf8"));
  db.prepare(
    `INSERT INTO collaboration_rooms (room_id, tenant_id, workspace_id, title, visibility, created_by_user_id, created_at)
     VALUES ('room_alpha', ?, 'ws_demo', 'engineering', 'shared', 'ada@example.test', 1)`,
  ).run(COLLAB_TENANT_ID);
  db.prepare(
    `INSERT INTO collaboration_memberships (
       tenant_id, workspace_id, room_id, user_id, display_name, actor_id, actor_kind, role, status, capabilities_json, created_at
     ) VALUES (?, 'ws_demo', 'room_alpha', 'ada@example.test', 'Ada', 'human:ada@example.test', 'human', 'member', 'active', '[]', 1)`,
  ).run(COLLAB_TENANT_ID);
  return {
    prepare: (sql: string) => ({
      bind: (...values: unknown[]) => ({
        run: async () => {
          db.prepare(sql).run(...(values as never[]));
          return { meta: { changes: (db.prepare("SELECT changes() AS c").get() as { c?: number } | undefined)?.c ?? 0 } };
        },
        first: async <T>() => db.prepare(sql).get(...(values as never[])) as T | null,
        all: async <T>() => ({ results: db.prepare(sql).all(...(values as never[])) as T[] }),
      }),
    }),
  } as unknown as D1Database;
}

describe("workspace search fts", () => {
  it("finds tasks by title token", async () => {
    const env = { AGENT_AUDIT: makeD1() };
    const now = Date.now();
    await upsertWorkspaceSearchDoc(env, "ws_demo", "task_1", "task", "Add README line", "scratch repo", now);
    const hits = await searchWorkspace(env, "ws_demo", "README", "ada@example.test");
    expect(hits.some((hit) => hit.kind === "task" && hit.id === "task_1")).toBe(true);
    const rooms = await searchWorkspace(env, "ws_demo", "engineering", "ada@example.test");
    expect(rooms[0]?.kind).toBe("room");
  });
});
