import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

const migrations = new URL("../migrations/", import.meta.url);
const scrub = "0076_scrub_schedule_grant_ciphertext.sql";
const files = readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort();

const insert = `INSERT INTO founder_reconciliation_schedules
  (id, workspace_id, owner_id, owner_account_id, owner_json, sample_id, sample_hash, sample_digest, input_json, sources_json,
   hub_grant_json, stripe_grant_json, contract_json, digest, executor_digest, expires_at, max_comparisons, max_skew_minutes,
   state, created_at, updated_at)
  VALUES (?, 'w', 'u', 'a', '{}', 's', 'h', 'd', '{}', '[]', ?, ?, '{}', 'digest', 'exec', 9, 1, 1, ?, 1, 2)`;

describe("0076 scrub schedule grant ciphertext", () => {
  it("removes the sealed credential, fails live schedules closed and leaves clean rows alone", () => {
    const { sqlite } = customAgentD1({ bare: true });
    try {
      for (const file of files.filter((name) => name < scrub)) sqlite.exec(readFileSync(new URL(file, migrations), "utf8"));
      const old = (extra: object) => JSON.stringify({ id: "g", revision: 3, ciphertext: "SEALED", ...extra });
      const clean = JSON.stringify({ id: "g", revision: 3 });
      const add = (id: string, hub: string, stripe: string, state: string) => sqlite.prepare(insert).run(id, hub, stripe, state);
      add("enabled", old({}), old({}), "enabled");
      add("paused", old({}), clean, "paused");
      add("draft", clean, old({}), "draft");
      add("revoked", old({}), old({}), "revoked");
      add("clean", clean, clean, "enabled");
      add("malformed", "not json", old({}), "enabled");

      const slack = (id: string, state: string, hub: string) => sqlite.prepare(`INSERT INTO founder_reconciliation_slack_grants
        (id, workspace_id, owner_id, owner_account_id, owner_json, request_id, input_hash, digest, version, source_kind, family_json, sample_result_id, sample_digest,
         destination_json, audience_json, policy_json, link_created_at, room_id, link_id, destination_key, max_sends, state, created_at, expires_at, review_expires_at)
        VALUES (?, 'w', 'u', 'a', '{}', ?, 'h', 'd', 1, 'reconciliation-schedule.v1', ?, 's', 'd', '{}', '{}', '{}', 1, 'r', 'l', 'k', 1, ?, 1, 9, 9)`)
        .run(id, id, JSON.stringify({ schedule: { id: "sch", hub_grant_json: hub, stripe_grant_json: clean } }), state);
      slack("slack-live", "enabled", old({}));
      slack("slack-clean", "enabled", clean);

      const migration = readFileSync(new URL(scrub, migrations), "utf8");
      sqlite.exec(migration);
      const rows = Object.fromEntries(
        (sqlite.prepare("SELECT id, state, hub_grant_json hub, stripe_grant_json stripe, updated_at u FROM founder_reconciliation_schedules").all() as Array<Record<string, string | number>>)
          .map((row) => [row.id, row]),
      );

      for (const id of ["enabled", "paused", "draft", "revoked", "malformed"]) {
        expect(`${rows[id]?.hub}${rows[id]?.stripe}`).not.toContain("SEALED");
      }
      expect(JSON.parse(String(rows.enabled?.hub))).toEqual({ id: "g", revision: 3 });
      expect(["enabled", "paused", "draft", "malformed"].map((id) => rows[id]?.state)).toEqual(["blocked", "blocked", "blocked", "blocked"]);
      expect(rows.revoked?.state).toBe("revoked");
      expect(rows.malformed?.hub).toBe("not json");
      expect(rows.clean).toMatchObject({ state: "enabled", hub: clean, stripe: clean, u: 2 });

      const family = (id: string) => sqlite.prepare("SELECT state, family_json f FROM founder_reconciliation_slack_grants WHERE id=?").get(id) as { state: string; f: string };
      expect(family("slack-live").f).not.toContain("SEALED");
      expect(JSON.parse(JSON.parse(family("slack-live").f).schedule.hub_grant_json)).toEqual({ id: "g", revision: 3 });
      expect(family("slack-live").state).toBe("blocked");
      expect(family("slack-clean").state).toBe("enabled");

      const before = JSON.stringify(sqlite.prepare("SELECT * FROM founder_reconciliation_schedules ORDER BY id").all());
      sqlite.exec(migration);
      expect(JSON.stringify(sqlite.prepare("SELECT * FROM founder_reconciliation_schedules ORDER BY id").all())).toBe(before);
    } finally {
      sqlite.close();
    }
  });
});
