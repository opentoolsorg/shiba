import { describe, expect, it } from "vitest";
import { captureShellEnv, fallbackEnv, parseEnv, sanitize } from "../src/shell-env";

const M = "\0__SHIBA_ENV__\0";

describe("shell-env", () => {
  it("ignores rc banner noise before the marker", () => {
    const out = `Welcome!\nPATH=bogus\0${M}PATH=/usr/bin\0FOO=a=b\0`;
    expect(parseEnv(out)).toEqual({ PATH: "/usr/bin", FOO: "a=b" });
  });

  it("returns null without a marker", () => {
    expect(parseEnv("PATH=/x\0")).toBeNull();
  });

  it("strips forbidden vars and keeps the rest", () => {
    const env = sanitize({
      SHIBA_WORKER_URL: "u", LOCAL_ADAPTER_TOKEN: "t", NODE_OPTIONS: "--inspect",
      ELECTRON_RUN_AS_NODE: "1", ANTHROPIC_API_KEY: "k", PATH: "/bin",
    });
    expect(env).toEqual({ ANTHROPIC_API_KEY: "k", PATH: "/bin" });
  });

  it("fallback appends the homebrew/local paths once", () => {
    const env = fallbackEnv({ PATH: "/usr/bin:/usr/local/bin" }, "/home/me");
    expect(env.PATH).toBe("/usr/bin:/usr/local/bin:/opt/homebrew/bin:/home/me/.local/bin");
  });

  it("falls back and sanitizes when the shell is missing", async () => {
    const env = await captureShellEnv({ PATH: "/bin", NODE_OPTIONS: "x" }, "/nonexistent/shell");
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.PATH).toContain("/opt/homebrew/bin");
  });
});
