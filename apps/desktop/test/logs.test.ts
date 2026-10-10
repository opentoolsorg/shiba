import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createLogger } from "../src/logs";

it("rotates to one .1 file at the size cap", () => {
  const dir = mkdtempSync(join(tmpdir(), "shiba-logs-"));
  const log = createLogger(dir, "daemon.log", 100);
  log.line("a".repeat(60));
  log.line("b".repeat(60));
  log.line("c".repeat(60));
  expect(readFileSync(join(dir, "daemon.log"), "utf8")).toContain("c".repeat(60));
  expect(readFileSync(join(dir, "daemon.log.1"), "utf8")).toContain("b".repeat(60));
  expect(existsSync(join(dir, "daemon.log.2"))).toBe(false);
});
