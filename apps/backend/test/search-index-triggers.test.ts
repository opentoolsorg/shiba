import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { COLLAB_TENANT_ID } from "../src/collaboration-store.js";

const FILES = ["0052_search_fts.sql", "0060_palette_search.sql"];
const databases: DatabaseSync[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

function open(): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  databases.push(sqlite);
  for (const file of FILES) sqlite.exec(readFileSync(join(import.meta.dirname, "../migrations", file), "utf8"));
  return sqlite;
}

function room(sqlite: DatabaseSync, id: string, title: string) {
  sqlite.prepare(
    `INSERT INTO collaboration_rooms (room_id, tenant_id, workspace_id, title, visibility, created_by_user_id, created_at)
     VALUES (?, ?, 'ws_demo', ?, 'private', 'ada@example.test', 1)`,
  ).run(id, COLLAB_TENANT_ID, title);
  sqlite.prepare(
    `INSERT INTO collaboration_memberships (
       tenant_id, workspace_id, room_id, user_id, display_name, actor_id, actor_kind, role, status, capabilities_json, created_at
     ) VALUES (?, 'ws_demo', ?, 'ada@example.test', 'Ada', 'human:ada@example.test', 'human', 'owner', 'active', '[]', 1),
              (?, 'ws_demo', ?, 'ada@example.test', 'Fixer', 'agent:fixer', 'agent', 'agent', 'active', '[]', 1)`,
  ).run(COLLAB_TENANT_ID, id, COLLAB_TENANT_ID, id);
}

function message(sqlite: DatabaseSync, id: string, body: string, at = 5) {
  sqlite.prepare(
    `INSERT INTO collaboration_messages (
       message_id, tenant_id, workspace_id, room_id, sender_user_id, sender_actor_id, sender_kind, body, created_at
     ) VALUES (?, ?, 'ws_demo', 'room_r', 'ada@example.test', 'agent:fixer', 'agent', ?, ?)`,
  ).run(id, COLLAB_TENANT_ID, body, at);
}

describe("search index triggers", () => {
  it("indexes, replaces and deletes message docs", () => {
    const sqlite = open();
    room(sqlite, "room_r", "Release");
    message(sqlite, "msg_1", "Opened the badge notes");
    const docs = () => sqlite.prepare(
      `SELECT doc_id, body FROM workspace_search_docs WHERE tenant_id = ? AND kind = 'message'`,
    ).all(COLLAB_TENANT_ID) as Array<{ doc_id: string; body: string }>;
    expect(docs()).toEqual([{ doc_id: "room_r:msg_1", body: "Opened the badge notes" }]);
    sqlite.prepare("UPDATE collaboration_messages SET body = ? WHERE message_id = 'msg_1'").run("Working · editing 3 files");
    expect(docs()).toEqual([{ doc_id: "room_r:msg_1", body: "Working · editing 3 files" }]);
    const found = sqlite.prepare(
      `SELECT d.doc_id FROM workspace_search_docs d JOIN workspace_search_fts ON workspace_search_fts.rowid = d.rowid
       WHERE workspace_search_fts MATCH '"editing"'`,
    ).all() as Array<{ doc_id: string }>;
    expect(found.map((row) => row.doc_id)).toEqual(["room_r:msg_1"]);
    const preview = sqlite.prepare("SELECT preview FROM bot_room_activity WHERE actor_id = 'agent:fixer'").get() as { preview: string };
    expect(preview.preview).toBe("Working · editing 3 files");
    sqlite.prepare("DELETE FROM collaboration_messages WHERE message_id = 'msg_1'").run();
    expect(docs()).toEqual([]);
  });

  it("indexes room title changes and backfills rows written before the trigger", () => {
    const sqlite = open();
    room(sqlite, "room_r", "Release");
    expect(sqlite.prepare("SELECT title FROM workspace_search_docs WHERE kind = 'room'").get()).toMatchObject({ title: "Release" });
    sqlite.prepare("UPDATE collaboration_rooms SET title = 'Launch' WHERE room_id = 'room_r'").run();
    expect(sqlite.prepare("SELECT COUNT(*) AS n, title FROM workspace_search_docs WHERE kind = 'room'").get()).toMatchObject({ n: 1, title: "Launch" });
    sqlite.exec("DROP TRIGGER palette_search_message_ai");
    message(sqlite, "msg_old", "legacy badge text", 9);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM workspace_search_docs WHERE doc_id = 'room_r:msg_old'").get()).toMatchObject({ n: 0 });
    const sql = readFileSync(join(import.meta.dirname, "../migrations/0060_palette_search.sql"), "utf8");
    const backfill = sql.slice(sql.indexOf("-- backfill-start"), sql.indexOf("-- backfill-end"));
    sqlite.exec(backfill);
    expect(sqlite.prepare("SELECT body FROM workspace_search_docs WHERE doc_id = 'room_r:msg_old'").get()).toMatchObject({ body: "legacy badge text" });
  });
});
