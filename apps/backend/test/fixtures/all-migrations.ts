import { readFileSync, readdirSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

const directory = new URL("../../migrations/", import.meta.url);
const applied = new WeakMap<DatabaseSync, Set<string>>();

/** Install the same ordered schema as a fresh D1 deployment. */
export function applyAllMigrations(sqlite: DatabaseSync, through = Infinity): void {
  let files = applied.get(sqlite);
  if (!files) {
    files = new Set();
    applied.set(sqlite, files);
  }
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
    if (Number.parseInt(file, 10) > through || files.has(file)) continue;
    sqlite.exec("BEGIN");
    try {
      sqlite.exec(readFileSync(new URL(file, directory), "utf8"));
      sqlite.exec("COMMIT");
      files.add(file);
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}
