import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createLogger, formatLogEvent, sanitizeLogLine } from "../src/logs";
import { createLineBuffer } from "../src/safe-text";

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

it("redacts credential shapes and keeps run ids readable", () => {
  const token = `${"A".repeat(48)}.${"B".repeat(32)}`;
  expect(sanitizeLogLine(`pair failed for ${token}`)).toBe("pair failed for [redacted]");
  expect(sanitizeLogLine("sent Bearer abcdefghijklmnop")).toBe("sent Bearer [redacted]");
  expect(sanitizeLogLine('request { "pairingToken": "secret-value" }')).toContain("[redacted]");
  expect(sanitizeLogLine("adapterToken=abcdef123456")).toContain("[redacted]");
  // Debuggability: ids that are not credentials survive untouched.
  const runId = "2f8c1c3a-9f4b-4d1e-8f2a-6c1b7e5d9a01";
  expect(sanitizeLogLine(`run ${runId} settled`)).toBe(`run ${runId} settled`);
});

it("writes one JSON line with allowlisted keys only", () => {
  const dir = mkdtempSync(join(tmpdir(), "shiba-logs-"));
  const log = createLogger(dir, "main.log", 100_000);
  log.event({ event: "navigation", action: "deny", url: "https://example.org/", detail: undefined });
  log.event({ event: "pair", state: "paired", token: "abc.def" } as never);
  const lines = readFileSync(join(dir, "main.log"), "utf8").trim().split("\n");
  const first = JSON.parse(lines[0]!.replace(/^\S+ /, "")) as Record<string, unknown>;
  expect(first).toEqual({ event: "navigation", action: "deny", url: "https://example.org/" });
  expect(lines[1]).not.toContain("abc.def");
});

it("formatLogEvent drops keys outside the allowlist", () => {
  const line = formatLogEvent({ event: "daemon-exit", code: 78, action: "revoked", pairingToken: "x.y" } as never);
  expect(JSON.parse(line)).toEqual({ event: "daemon-exit", code: 78, action: "revoked" });
});

it("drops control characters from any logged value", () => {
  expect(sanitizeLogLine("bad\u0000line\u001b[31m")).toBe("badline[31m");
  expect(sanitizeLogLine("multi\nline")).toBe("multiline");
});

it("buffers stream chunks into complete lines so a split token is still redacted", () => {
  const lines: string[] = [];
  const buffer = createLineBuffer((line) => lines.push(sanitizeLogLine(line)));
  const token = `${"A".repeat(48)}.${"B".repeat(32)}`;
  const whole = `shiba-local: paired ${token}\nnext line\n`;
  // Split inside the token, exactly where a naive per-chunk scrub would miss it.
  buffer.push(whole.slice(0, 35));
  buffer.push(whole.slice(35));
  expect(lines).toEqual(["shiba-local: paired [redacted]", "next line"]);
});

it("drops an oversized incomplete line instead of writing its fragments", () => {
  const lines: string[] = [];
  const buffer = createLineBuffer((line) => lines.push(line), 16);
  buffer.push("x".repeat(40));
  buffer.push("still-no-newline");
  buffer.push("-end\nfine\n");
  expect(lines).toEqual(["fine"]);
});
