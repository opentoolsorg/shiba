import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { searchWorkspace, upsertWorkspaceSearchDoc } from "../src/workspace-search-store.js";

function makeD1(): D1Database {
  const db = new DatabaseSync(":memory:");
  const ddl = readFileSync(join(import.meta.dirname, "../migrations/0052_search_fts.sql"), "utf8");
  db.exec(ddl);
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
    await upsertWorkspaceSearchDoc(env, "ws_demo", "room_alpha", "room", "engineering", "standup notes", now);
    const hits = await searchWorkspace(env, "ws_demo", "README");
    expect(hits.some((hit) => hit.kind === "task" && hit.id === "task_1")).toBe(true);
    const rooms = await searchWorkspace(env, "ws_demo", "engineering");
    expect(rooms[0]?.kind).toBe("room");
  });
});