#!/usr/bin/env node
/**
 * schema-snapshot.mjs — deterministic D1 schema snapshot for diffing.
 * (docs/proposals/target-architecture-2026-11.md §16 migration rehearsal,
 *  §18 Phase 0 M02)
 *
 * Produces a canonical, sorted text dump of sqlite_master so two snapshots
 * can be compared with `diff -u`. Used by .github/workflows/migration-
 * rehearsal.yml and usable locally to prove "a fresh D1 built from
 * migrations alone" matches a migrated one (the M11 acceptance check).
 *
 * Modes (pick one):
 *
 *   # Fresh schema: apply every apps/backend/migrations/*.sql to an
 *   # in-memory sqlite and dump it. This is the default with no args.
 *   node scripts/schema-snapshot.mjs [--migrations <dir>] [--db <file>]
 *
 *   # Remote/local D1 via wrangler JSON output:
 *   QUERY="$(node scripts/schema-snapshot.mjs --print-sql)"
 *   pnpm exec wrangler d1 execute AGENT_AUDIT --remote \
 *     --config apps/backend/wrangler.jsonc --json --command "$QUERY" > snap.json
 *   node scripts/schema-snapshot.mjs --from-json snap.json --label prod-before
 *   node scripts/schema-snapshot.mjs --from-json - --label x < snap.json   # stdin
 *
 * Options:
 *   --migrations <dir>   apply *.sql (sorted) before dumping
 *                        (default: apps/backend/migrations when --db is :memory:)
 *   --db <path>          sqlite file for the local mode (default :memory:)
 *   --from-json <file>   parse `wrangler d1 execute --json` output ("-" = stdin)
 *   --print-sql          print the canonical sqlite_master query and exit —
 *                        keeps the workflow's --command in sync with this file
 *   --label <text>       recorded in the "# source:" header line
 *
 * Output format (one object per line, sorted by type then name):
 *   # shiba schema snapshot v1
 *   # source: <label>
 *   TABLE|audit_log|CREATE TABLE audit_log (...)
 *   INDEX|audit_log_ts|CREATE INDEX audit_log_ts ON audit_log(ts)
 *
 * Normalization: SQL text has all whitespace runs collapsed to one space.
 * d1_migrations is excluded — it is wrangler bookkeeping, not app schema,
 * and its contents differ between a migrated prod copy and a fresh build.
 * sqlite_% internal tables are excluded as well.
 *
 * node:sqlite needs Node >= 22.5; on the Node 22 LTS line it still requires
 * --experimental-sqlite, which this script re-execs itself with when the
 * import fails. --from-json/--print-sql never touch sqlite and run anywhere.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_MIGRATIONS = join(repoRoot, "apps", "backend", "migrations");

/**
 * Canonical schema query. The rehearsal workflow runs exactly this against
 * the scratch D1 via `wrangler d1 execute --json --command`; the local
 * sqlite path applies the same filter in snapshotFromSqlite() — keep them
 * in sync.
 */
const SCHEMA_QUERY = `SELECT type, name, tbl_name, sql
FROM sqlite_master
WHERE substr(name, 1, 7) != 'sqlite_'
  AND name != 'd1_migrations'
ORDER BY type, name`;

const INTERNAL_PREFIXES = ["sqlite_"];
const EXCLUDED_NAMES = new Set(["d1_migrations"]);

const USAGE = `Usage:
  node scripts/schema-snapshot.mjs [--migrations <dir>] [--db <file>] [--label <text>]
  node scripts/schema-snapshot.mjs --from-json <file|-> [--label <text>]
  node scripts/schema-snapshot.mjs --print-sql

See the header comment in scripts/schema-snapshot.mjs for details.`;

function parseArgs(argv) {
  const args = {
    migrations: null,
    db: ":memory:",
    fromJson: null,
    label: "",
    printSql: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      return value;
    };
    switch (arg) {
      case "--migrations":
        args.migrations = resolve(next());
        break;
      case "--db":
        args.db = next();
        break;
      case "--from-json":
        args.fromJson = next();
        break;
      case "--label":
        args.label = next();
        break;
      case "--print-sql":
        args.printSql = true;
        break;
      case "--help":
      case "-h":
        console.log(USAGE);
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

/** Canonical text form: stable across D1/local sqlite and whitespace drift. */
function normalizeSql(sql) {
  return String(sql ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function emitSnapshot(rows, label) {
  const objects = rows
    .filter((row) => {
      const name = String(row.name ?? "");
      return (
        name.length > 0 &&
        !EXCLUDED_NAMES.has(name) &&
        !INTERNAL_PREFIXES.some((prefix) => name.startsWith(prefix))
      );
    })
    .map((row) => ({
      type: String(row.type ?? "").toUpperCase(),
      name: String(row.name),
      sql: normalizeSql(row.sql),
    }))
    .sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type.localeCompare(b.type),
    );

  const out = [
    "# shiba schema snapshot v1",
    `# source: ${label || "unknown"}`,
    ...objects.map((o) => `${o.type}|${o.name}|${o.sql}`),
    "",
  ];
  process.stdout.write(out.join("\n"));
  return objects.length;
}

/**
 * Rows from `wrangler d1 execute --json` output (array of statement
 * results). `statements` counts items that carried a results array, so the
 * caller can tell "query succeeded with zero rows" (a legitimately empty
 * schema — the fixture rehearsal case) apart from "not wrangler JSON".
 */
function rowsFromWranglerJson(text) {
  const parsed = JSON.parse(text);
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const rows = [];
  let statements = 0;
  for (const item of list) {
    if (Array.isArray(item?.results)) {
      statements += 1;
      rows.push(...item.results);
    } else if (
      item &&
      typeof item === "object" &&
      ("name" in item || "type" in item)
    ) {
      rows.push(item); // already bare rows
      statements += 1;
    }
  }
  return { rows, statements };
}

async function loadNodeSqlite() {
  try {
    return await import("node:sqlite");
  } catch {
    // Node 22 LTS still gates node:sqlite behind --experimental-sqlite;
    // re-exec once with the flag rather than making callers remember it.
    if (!process.execArgv.includes("--experimental-sqlite")) {
      const result = spawnSync(
        process.execPath,
        ["--experimental-sqlite", fileURLToPath(import.meta.url), ...process.argv.slice(2)],
        { stdio: "inherit", env: process.env },
      );
      process.exit(result.status ?? 1);
    }
    throw new Error(
      "node:sqlite is unavailable — needs Node >= 22.5 (with " +
        "--experimental-sqlite on the 22 line) or Node >= 24",
    );
  }
}

async function snapshotFromSqlite(dbPath, migrationsDir) {
  const { DatabaseSync } = await loadNodeSqlite();
  const db = new DatabaseSync(dbPath === ":memory:" ? ":memory:" : resolve(dbPath));
  try {
    if (migrationsDir) {
      const files = readdirSync(migrationsDir)
        .filter((name) => name.endsWith(".sql"))
        .sort();
      for (const file of files) {
        db.exec(readFileSync(join(migrationsDir, file), "utf8"));
      }
    }
    // Same filter as SCHEMA_QUERY — the JSON path gets it from wrangler.
    return db
      .prepare(
        `SELECT type, name, tbl_name, sql FROM sqlite_master
         WHERE substr(name, 1, 7) != 'sqlite_' AND name != 'd1_migrations'
         ORDER BY type, name`,
      )
      .all();
  } finally {
    db.close();
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`schema-snapshot: ${error.message}\n${USAGE}`);
    process.exit(2);
  }

  if (args.printSql) {
    process.stdout.write(`${SCHEMA_QUERY}\n`);
    return;
  }

  let rows;
  let label = args.label;
  if (args.fromJson !== null) {
    const text =
      args.fromJson === "-"
        ? readFileSync(0, "utf8")
        : readFileSync(resolve(args.fromJson), "utf8");
    const parsedJson = rowsFromWranglerJson(text);
    rows = parsedJson.rows;
    if (parsedJson.statements === 0) {
      console.error(
        "schema-snapshot: input has no wrangler statement results — " +
          "expected `wrangler d1 execute --json` output",
      );
      process.exit(2);
    }
  } else {
    // Default: fresh in-memory schema built from the migration chain.
    // --db <file> without --migrations dumps that file as-is.
    const migrationsDir = args.migrations ?? (args.db === ":memory:" ? DEFAULT_MIGRATIONS : null);
    if (!label && migrationsDir) {
      const rel = relative(repoRoot, migrationsDir).split("\\").join("/");
      label = `migrations:${rel.startsWith("..") ? migrationsDir : rel}`;
    }
    if (!label) label = "unknown";
    rows = await snapshotFromSqlite(args.db, migrationsDir);
  }

  const count = emitSnapshot(rows, label);
  console.error(`schema-snapshot: ${count} schema objects`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  // `snapshot | head` closes stdout early — treat EPIPE as a clean exit.
  process.stdout.on("error", (error) => {
    if (error.code === "EPIPE") process.exit(0);
    throw error;
  });
  main().catch((error) => {
    console.error(`schema-snapshot: ${error.message}`);
    process.exit(1);
  });
}
