import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ensureCollaborationSchema } from "../src/collaboration-store.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import { ensureTeamModelSchema } from "../src/team-model-store.js";
import type { Env } from "../src/env.js";

const migration = readFileSync(new URL("../migrations/0013_team_model_sessions.sql", import.meta.url), "utf8");
const room = "room_aaaaaaaaaaaaaaaaaaaaaaaa", workspace = "ws_aaaaaaaaaaaaaaaaaaaaaaaa", member = "human:member@example.test";
function seedRoom(sqlite: ReturnType<typeof customAgentD1>["sqlite"]) {
  sqlite.prepare("INSERT INTO collaboration_rooms VALUES(?,'self-hosted',?,'Preserved shared room','shared','owner@example.test',1)").run(room, workspace);
  sqlite.prepare("INSERT INTO collaboration_memberships(tenant_id,workspace_id,room_id,user_id,display_name,actor_id,actor_kind,role,status,capabilities_json,created_at) VALUES('self-hosted',?,?,'member@example.test','Preserved member',?,'human','member','active','[\"room.read\"]',2)").run(workspace, room, member);
}
function seedFunding(sqlite: ReturnType<typeof customAgentD1>["sqlite"]) {
  sqlite.prepare("INSERT INTO team_model_funding(id,workspace_id,room_id,issuer_id,recipient_id,version,digest,binding_json,contract_json,policy_key,state,review_expires_at,created_at,updated_at) VALUES('migration-funding',?,?,'owner@example.test','member@example.test',1,'digest',?,'{}','policy','active',9999999999999,3,3)")
    .run(workspace, room, JSON.stringify({ recipientRoom: { actorId: member } }));
}
describe("unreleased team-model migration collaboration prerequisites", () => {
  it("adds the canonical append-only money ledger without changing legacy rows or weakening its constraints", async () => {
    const legacy = customAgentD1(), runtime = customAgentD1();
    try {
      legacy.sqlite.exec(migration); seedRoom(legacy.sqlite); seedFunding(legacy.sqlite);
      const original = legacy.sqlite.prepare("SELECT * FROM team_model_funding").get();
      const moneyMigration = readFileSync(new URL("../migrations/0017_team_model_money.sql", import.meta.url), "utf8");
      legacy.sqlite.exec(moneyMigration); legacy.sqlite.exec(moneyMigration);
      const budgetMigration = readFileSync(new URL("../migrations/0025_team_model_budget_v3.sql", import.meta.url), "utf8");
      legacy.sqlite.exec(budgetMigration); legacy.sqlite.exec(budgetMigration);
      await ensureTeamModelSchema({ AGENT_AUDIT: runtime.database } as Env);
      expect(legacy.sqlite.prepare("SELECT * FROM team_model_funding").get()).toEqual(original);
      expect(legacy.sqlite.prepare("PRAGMA table_info(team_model_money_ledger)").all()).toEqual(runtime.sqlite.prepare("PRAGMA table_info(team_model_money_ledger)").all());
      expect(legacy.sqlite.prepare("PRAGMA index_list(team_model_money_ledger)").all()).toEqual(runtime.sqlite.prepare("PRAGMA index_list(team_model_money_ledger)").all());
      const insert = legacy.sqlite.prepare("INSERT INTO team_model_money_ledger(turn_id,grant_id,workspace_id,input_hash,quote_digest,reserved_micro_usd,state,created_at,updated_at) VALUES(?,'grant','workspace','hash','quote',?,'held',1,1)");
      insert.run("turn", 8341); expect(() => insert.run("turn", 8341)).toThrow(); expect(() => insert.run("oversized", 8342)).toThrow(); expect(() => insert.run("negative", -1)).toThrow();
    } finally { legacy.sqlite.close(); runtime.sqlite.close(); }
  });
  it("creates the complete canonical room and membership schema on an empty database", async () => {
    const migrated = customAgentD1(), runtime = customAgentD1();
    try {
      migrated.sqlite.exec(migration);
      await ensureCollaborationSchema({ AGENT_AUDIT: runtime.database });
      for (const table of ["collaboration_rooms", "collaboration_memberships"]) {
        expect(migrated.sqlite.prepare(`PRAGMA table_info(${table})`).all()).toEqual(runtime.sqlite.prepare(`PRAGMA table_info(${table})`).all());
        expect(migrated.sqlite.prepare(`PRAGMA foreign_key_list(${table})`).all()).toEqual(runtime.sqlite.prepare(`PRAGMA foreign_key_list(${table})`).all());
        expect(migrated.sqlite.prepare(`PRAGMA index_list(${table})`).all()).toEqual(runtime.sqlite.prepare(`PRAGMA index_list(${table})`).all());
      }
      seedRoom(migrated.sqlite);
      expect(() => migrated.sqlite.prepare("UPDATE collaboration_memberships SET actor_kind='untrusted'").run()).toThrow();
      expect(() => migrated.sqlite.prepare("UPDATE collaboration_memberships SET role='admin'").run()).toThrow();
      expect(() => migrated.sqlite.prepare("UPDATE collaboration_memberships SET status='revived'").run()).toThrow();
    } finally { migrated.sqlite.close(); runtime.sqlite.close(); }
  });
  it("preserves existing runtime-created room rows and installs permanent remove/re-add invalidation", async () => {
    const existing = customAgentD1();
    try {
      await ensureCollaborationSchema({ AGENT_AUDIT: existing.database }); seedRoom(existing.sqlite);
      const originalRoom = existing.sqlite.prepare("SELECT * FROM collaboration_rooms").get(), originalMember = existing.sqlite.prepare("SELECT * FROM collaboration_memberships").get();
      existing.sqlite.exec(migration);
      expect(existing.sqlite.prepare("SELECT * FROM collaboration_rooms").get()).toEqual(originalRoom);
      expect(existing.sqlite.prepare("SELECT * FROM collaboration_memberships").get()).toEqual(originalMember);
      seedFunding(existing.sqlite);
      existing.sqlite.prepare("UPDATE collaboration_memberships SET status='removed' WHERE actor_id=?").run(member);
      existing.sqlite.prepare("UPDATE collaboration_memberships SET status='active' WHERE actor_id=?").run(member);
      expect(existing.sqlite.prepare("SELECT state,version FROM team_model_funding").get()).toEqual({ state: "blocked", version: 2 });
    } finally { existing.sqlite.close(); }
  });
  it("retains foreign-key and deletion-trigger behavior after fresh migration", () => {
    const migrated = customAgentD1();
    try {
      migrated.sqlite.exec("PRAGMA foreign_keys=ON"); migrated.sqlite.exec(migration); seedRoom(migrated.sqlite); seedFunding(migrated.sqlite);
      migrated.sqlite.prepare("DELETE FROM collaboration_rooms WHERE room_id=?").run(room);
      expect(migrated.sqlite.prepare("SELECT COUNT(*) AS count FROM collaboration_memberships").get()).toEqual({ count: 0 });
      expect(migrated.sqlite.prepare("SELECT state,version FROM team_model_funding").get()).toEqual({ state: "blocked", version: 2 });
    } finally { migrated.sqlite.close(); }
  });
});
