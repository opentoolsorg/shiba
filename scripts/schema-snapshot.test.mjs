import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const SNAPSHOT = "scripts/schema-snapshot.mjs";

function run(args) {
  return spawnSync("node", [SNAPSHOT, ...args], { encoding: "utf8" });
}

test("default mode dumps the fresh migration-built schema deterministically", () => {
  const first = run([]);
  const second = run([]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stdout, second.stdout);
  assert.match(first.stdout, /^# shiba schema snapshot v1\n/);
  assert.match(first.stdout, /^# source: migrations:apps\/backend\/migrations$/m);
  assert.match(first.stdout, /^TABLE\|/m);
  assert.match(first.stderr, /schema objects/);
});

test("--print-sql emits the canonical sqlite_master query", () => {
  const result = run(["--print-sql"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /FROM sqlite_master/);
  assert.match(result.stdout, /d1_migrations/);
});

test("--from-json parses wrangler output and excludes bookkeeping tables", () => {
  const dir = mkdtempSync(join(tmpdir(), "schema-snapshot-"));
  const file = join(dir, "wrangler.json");
  writeFileSync(
    file,
    JSON.stringify([
      {
        results: [
          {
            type: "table",
            name: "audit_log",
            tbl_name: "audit_log",
            sql: "CREATE TABLE audit_log (\n  id TEXT PRIMARY KEY\n)",
          },
          {
            type: "index",
            name: "audit_log_ts",
            tbl_name: "audit_log",
            sql: "CREATE INDEX audit_log_ts   ON audit_log(ts)",
          },
          {
            type: "table",
            name: "d1_migrations",
            tbl_name: "d1_migrations",
            sql: "CREATE TABLE d1_migrations (id INTEGER)",
          },
          { type: "table", name: "sqlite_sequence", tbl_name: "sqlite_sequence", sql: null },
        ],
        success: true,
        meta: {},
      },
    ]),
  );
  const result = run(["--from-json", file, "--label", "fixture"]);
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split("\n");
  assert.deepEqual(lines.slice(2), [
    "INDEX|audit_log_ts|CREATE INDEX audit_log_ts ON audit_log(ts)",
    "TABLE|audit_log|CREATE TABLE audit_log ( id TEXT PRIMARY KEY )",
  ]);
});
