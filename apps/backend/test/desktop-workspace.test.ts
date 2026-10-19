import { describe, expect, it } from "vitest";
import {
  DESKTOP_STREAM_TTL_MS,
  mintDesktopStreamToken,
  verifyDesktopStreamToken,
} from "../src/sandbox/desktop-tokens.js";
import { formatExecLogLines } from "../src/agents/run-workspace-handlers.js";
import { isSandboxDesktopEnabled, previewUrlsFromExpose } from "../src/sandbox/desktop.js";
import { screenActionArgv } from "../src/screen-control.js";
import type { Env } from "../src/env.js";

describe("desktop tokens", () => {
  const env = { DESKTOP_STREAM_SECRET: "test-secret" } as Env;

  it("round-trips a stream token", async () => {
    const exp = Date.now() + DESKTOP_STREAM_TTL_MS;
    const token = await mintDesktopStreamToken(env, {
      runId: "run-1",
      userId: "user@example.com",
      purpose: "view",
      exp,
    });
    expect(token).toBeTruthy();
    const claims = await verifyDesktopStreamToken(env, token!);
    expect(claims?.runId).toBe("run-1");
    expect(claims?.purpose).toBe("view");
  });
});

describe("sandbox desktop helpers", () => {
  it("maps expose URLs to websocket entrypoints", () => {
    expect(previewUrlsFromExpose("https://6080-sb-tok.shiba.example.com/path")).toEqual({
      httpOrigin: "https://6080-sb-tok.shiba.example.com",
      wsUrl: "wss://6080-sb-tok.shiba.example.com/",
    });
  });

  it("is off unless SHIBA_SANDBOX_DESKTOP=1", () => {
    expect(isSandboxDesktopEnabled({} as Env)).toBe(false);
    expect(isSandboxDesktopEnabled({ SHIBA_SANDBOX_DESKTOP: "1" } as Env)).toBe(true);
  });
});

describe("screen open_url argv", () => {
  it("passes the URL as a single argv element", () => {
    const argv = screenActionArgv({ type: "open_url", url: "https://example.com/login" });
    expect(argv[0]).toEqual(["chromium", "--no-sandbox", "--new-window", "https://example.com/login"]);
  });
});

describe("workspace exec logs", () => {
  it("formats exec signals as lines", () => {
    const lines = formatExecLogLines([
      { kind: "exec.invoked", at: 1, detail: "git status" },
      { kind: "exec.settled", at: 2, detail: "exit 0" },
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("exec.invoked");
  });
});
