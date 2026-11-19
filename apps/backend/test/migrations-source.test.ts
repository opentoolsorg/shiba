import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";


const ts: typeof import("typescript") = createRequire(resolve(import.meta.dirname, "../../../package.json"))("typescript");
const root = resolve(import.meta.dirname, "../../..");
const script = join(root, "apps/backend/scripts/check-migrations.mjs");
const migrations = join(root, "apps/backend/migrations");

it("rejects runtime D1 DDL, new duplicates and gaps; permits local DO SQLite", () => {
  const fixture = mkdtempSync(join(tmpdir(), "shiba-migrations-"));
  const source = join(fixture, "apps/backend/src");
  const directory = join(fixture, "apps/backend/migrations");
  mkdirSync(source, { recursive: true });
  mkdirSync(directory, { recursive: true });
  mkdirSync(join(fixture, "packages/auth/src"), { recursive: true });
  const run = () => execFileSync(process.execPath, [script, fixture], { stdio: "pipe" });
  try {
    for (const file of ["0036_slack_coworker_private_status.sql", "0036_team_work_tasks.sql", "0060_palette_search.sql", "0061_next.sql"]) writeFileSync(join(directory, file), "");
    writeFileSync(join(source, "store.ts"), 'const db: D1Database = env.AGENT_AUDIT; db.prepare(`CREATE TABLE IF NOT EXISTS bad(id TEXT)`).run();');
    expect(run).toThrow(/Runtime D1 DDL/);
    writeFileSync(join(source, "store.ts"), 'const db: D1Database = env.AGENT_AUDIT; db.prepare(`CREATE TABLE IF NOT EXISTS ${table}(id TEXT)`).run();');
    expect(run).toThrow(/Runtime D1 DDL/);
    writeFileSync(join(source, "schema.ts"), 'export const SCHEMA = [`CREATE INDEX IF NOT EXISTS bad ON missing(id)`];');
    writeFileSync(join(source, "store.ts"), 'import { SCHEMA } from "./schema.js"; const db: D1Database = env.AGENT_AUDIT; for (const sql of SCHEMA) db.prepare(sql).run();');
    expect(run).toThrow(/Runtime D1 DDL/);
    writeFileSync(join(source, "store.ts"), 'import * as schema from "./schema.js"; env.AGENT_AUDIT.batch(schema.SCHEMA.map(sql => env.AGENT_AUDIT.prepare(sql)));');
    expect(run).toThrow(/Runtime D1 DDL/);
    writeFileSync(join(source, "forward.ts"), 'export { SCHEMA as DDL } from "./schema.js";');
    writeFileSync(join(source, "store.ts"), 'import { DDL } from "./forward.js"; env.AGENT_AUDIT.batch(DDL.map(sql => env.AGENT_AUDIT.prepare(sql)));');
    expect(run).toThrow(/Runtime D1 DDL/);
    writeFileSync(join(source, "store.ts"), 'class Room { constructor(ctx) { ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS local(id TEXT)`); } read() { return this.env.AGENT_AUDIT.prepare("SELECT 1"); } }');
    expect(run().toString()).toContain("passed");
    writeFileSync(join(directory, "0036_other.sql"), "");
    expect(run).toThrow(/Duplicate migration prefix/);
    rmSync(join(directory, "0036_other.sql"));
    writeFileSync(join(directory, "0020_backwards.sql"), "");
    expect(run).toThrow(/goes backwards/);
    rmSync(join(directory, "0020_backwards.sql"));
    writeFileSync(join(directory, "0063_gap.sql"), "");
    expect(run).toThrow(/expected 62/);
    rmSync(join(directory, "0063_gap.sql"));
    writeFileSync(join(directory, "0061_duplicate.sql"), "");
    expect(run).toThrow(/Duplicate migration prefix/);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
}, 30_000);

it("permits only the duplicate prefixes main already shipped", () => {
  const fixture = mkdtempSync(join(tmpdir(), "shiba-migrations-"));
  const directory = join(fixture, "apps/backend/migrations");
  mkdirSync(join(fixture, "apps/backend/src"), { recursive: true });
  mkdirSync(join(fixture, "packages/auth/src"), { recursive: true });
  mkdirSync(directory, { recursive: true });
  const run = () => execFileSync(process.execPath, [script, fixture], { stdio: "pipe" });
  try {
    for (const file of [
      "0036_slack_coworker_private_status.sql", "0036_team_work_tasks.sql",
      "0060_palette_search.sql",
      "0061_learning_review.sql", "0061_note_chat.sql",
      "0062_inbound_webhook_receipts.sql", "0062_media_generations.sql",
      "0063_runtime_d1_schema.sql", "0063_workspace_channel_facts.sql",
      "0064_thread_queue.sql", "0065_scheduled_job_slots.sql", "0066_routine_outcomes.sql",
      "0068_ui_block_questions.sql", "0069_employee_access.sql",
    ]) writeFileSync(join(directory, file), "");
    expect(run().toString()).toContain("passed");
    writeFileSync(join(directory, "0062_other.sql"), "");
    expect(run).toThrow(/Duplicate migration prefix/);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
}, 30_000);

it("keeps 0067 skipped after 0066 shipped", () => {
  const fixture = mkdtempSync(join(tmpdir(), "shiba-migrations-"));
  const directory = join(fixture, "apps/backend/migrations");
  mkdirSync(join(fixture, "apps/backend/src"), { recursive: true });
  mkdirSync(join(fixture, "packages/auth/src"), { recursive: true });
  mkdirSync(directory, { recursive: true });
  const run = () => execFileSync(process.execPath, [script, fixture], { stdio: "pipe" });
  try {
    for (const file of [
      "0060_palette_search.sql", "0061_note_chat.sql", "0062_media_generations.sql",
      "0063_runtime_d1_schema.sql", "0064_thread_queue.sql", "0065_scheduled_job_slots.sql",
      "0066_routine_outcomes.sql", "0068_ui_block_questions.sql", "0069_employee_access.sql",
    ]) writeFileSync(join(directory, file), "");
    expect(run().toString()).toContain("passed");
    writeFileSync(join(directory, "0067_late.sql"), "");
    expect(run).toThrow(/expected 68/);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
}, 30_000);

it("applies the entire migration history to fresh local D1 and covers queried tables", async () => {
  // Miniflare is supplied by the pinned Wrangler dev dependency.
  const require = createRequire(import.meta.url);
  const wranglerRequire = createRequire(require.resolve("wrangler/package.json"));
  const { Miniflare, convertV4MiniflareOptions } = wranglerRequire("miniflare");
  const { unstable_splitSqlQuery } = require("wrangler");
  const mf = new Miniflare(convertV4MiniflareOptions({ name: "migrations", modules: true, script: "export default { fetch() { return new Response('ok'); } }", compatibilityDate: "2026-09-01", d1Databases: ["AGENT_AUDIT"] }));
  try {
    const db = await mf.getD1Database("AGENT_AUDIT", "migrations");
    for (const file of readdirSync(migrations).filter(name => name.endsWith(".sql")).sort()) {
      // D1 exec treats newlines as statement boundaries; batch prepared statements instead.
      const sql = readFileSync(join(migrations, file), "utf8");
      const statements = unstable_splitSqlQuery(sql);
      await db.batch(statements.map((statement: string) => db.prepare(statement)));
    }
    const tables = new Set((await db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all()).results.map((row: { name: string }) => row.name));
    const { sourceFiles } = await import("../scripts/check-migrations.mjs");
    const missing = new Set<string>();
    for (const base of ["apps/backend/src", "packages/auth/src"]) {
      for (const file of sourceFiles(join(root, base))) {
        const source = readFileSync(file, "utf8");
        if (!/\b(?:AGENT_AUDIT|D1Database)\b/.test(source)) continue;
        const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
        function visit(node: import("typescript").Node): void {
          if (ts.isCallExpression(node) && node.expression.getText(ast).endsWith(".prepare")) {
            const argument = node.arguments[0];
            const sql = argument?.getText(ast) ?? "";
            const ctes = new Set([...sql.matchAll(/(?:WITH|,)\s+(\w+)\s+AS\s*\(/gi)].map(match => match[1]));
            for (const match of sql.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+["`]?([a-z_][a-z_0-9]*)/g)) {
              const table = match[1] ?? "";
              if (!tables.has(table) && !ctes.has(table) && !["sqlite_master", "sqlite_schema", "json_each", "json_tree"].includes(table)) missing.add(`${table} (${file.slice(root.length + 1)})`);
            }
          }
          ts.forEachChild(node, visit);
        }
        visit(ast);
      }
    }
    expect([...missing].sort()).toEqual([]);
    for (const query of [
      "SELECT employee_context_json,decision_owner_account_id,execution_context_id,consumed_at,consumed_invocation_id FROM employee_tool_approvals LIMIT 0",
      "SELECT operation_id,companion_machine_id,first_attempt_at,dispatch_state FROM reason_network_operations LIMIT 0",
      "SELECT draft_task_id,draft_task_json FROM user_onboarding_progress LIMIT 0",
      "SELECT executor_agent_name FROM collaboration_handoffs LIMIT 0",
    ]) await expect(db.prepare(query).all()).resolves.toMatchObject({ success: true });
  } finally { await mf.dispose(); }
}, 60_000);
