import fs from "node:fs/promises";
import path from "node:path";

/** Claude Code and Codex keep subscription logins in these directories. */
const OPERATOR_AUTH_DIRS = [".claude", ".codex"];

/**
 * Symlink the operator's CLI auth directories into a disposable run HOME.
 * Skips a name the run already has, and does nothing when the run HOME is
 * the operator HOME. Missing logins are ignored.
 * @param {string} homeDir
 * @param {string | undefined} userHome
 * @returns {Promise<string[]>}
 */
export async function linkOperatorAuth(homeDir, userHome) {
  if (!userHome) return [];
  if (path.resolve(userHome) === path.resolve(homeDir)) return [];
  const linked = [];
  for (const name of OPERATOR_AUTH_DIRS) {
    const source = path.join(userHome, name);
    const dest = path.join(homeDir, name);
    try {
      await fs.lstat(dest);
      continue;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") continue;
    }
    try {
      const stat = await fs.stat(source);
      if (!stat.isDirectory()) continue;
      await fs.symlink(source, dest);
      linked.push(name);
    } catch {
      // This computer has no login directory for that CLI.
    }
  }
  return linked;
}
