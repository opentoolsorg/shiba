import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { ClaudeSpawn } from "../src/claude-login.js";
import { CLAUDE_LOGIN_ARGS, CLAUDE_LOGIN_COMMAND, startClaudeLogin } from "../src/claude-login.js";

function fakeChild() {
  const child = new EventEmitter() as ChildProcess;
  child.kill = vi.fn();
  return child;
}

describe("startClaudeLogin", () => {
  it("spawns claude auth login and discards output", async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child) as unknown as ClaudeSpawn;
    const pending = startClaudeLogin({
      spawn,
      env: { HOME: "/Users/ada", PATH: "/usr/bin" },
      timeoutMs: 1000,
    });
    expect(spawn).toHaveBeenCalledWith(CLAUDE_LOGIN_COMMAND, CLAUDE_LOGIN_ARGS, {
      env: { HOME: "/Users/ada", PATH: "/usr/bin" },
      stdio: "ignore",
      windowsHide: true,
    });
    child.emit("exit", 0);
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it("reports a missing CLI without returning output", async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child) as unknown as ClaudeSpawn;
    const pending = startClaudeLogin({ spawn, env: {}, timeoutMs: 1000 });
    child.emit("error", new Error("spawn claude ENOENT"));
    await expect(pending).resolves.toEqual({
      ok: false,
      error: "Claude Code is not installed on this computer.",
    });
  });
});
