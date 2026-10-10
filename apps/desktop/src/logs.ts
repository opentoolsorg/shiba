import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

export const MAX_LOG_BYTES = 5 * 1024 * 1024;

export interface Logger {
  line(text: string): void;
}

// Appends to <dir>/<name>, rotating to a single <name>.1 once it would pass maxBytes.
export function createLogger(dir: string, name: string, maxBytes = MAX_LOG_BYTES): Logger {
  const file = join(dir, name);
  mkdirSync(dir, { recursive: true });
  return {
    line(text) {
      const data = `${new Date().toISOString()} ${text.replace(/\n$/, "")}\n`;
      try {
        if (statSync(file).size + data.length > maxBytes) renameSync(file, `${file}.1`);
      } catch {
        // no file yet
      }
      // Runs inside daemon stdout handlers in main: a full disk must not crash the app.
      try {
        appendFileSync(file, data);
      } catch {}
    },
  };
}
