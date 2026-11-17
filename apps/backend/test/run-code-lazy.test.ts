import { describe, expect, it, vi, afterEach } from "vitest";
import type { Env } from "../src/env.js";
import { ORCHESTRATOR_PRINCIPAL } from "../src/codemode-principal.js";
import {
  createLazyRunCodeTool,
  resetLazyRunCodeCacheForTests,
} from "../src/run-code-lazy.js";

vi.mock("../src/codemode.js", () => ({
  createRunCodeTool: vi.fn(() => ({
    description: "typed codemode",
    execute: vi.fn(async () => "ok"),
  })),
}));

afterEach(() => {
  resetLazyRunCodeCacheForTests();
  vi.clearAllMocks();
});

describe("createLazyRunCodeTool", () => {
  it("returns null without LOADER", () => {
    expect(createLazyRunCodeTool({} as Env, undefined, ORCHESTRATOR_PRINCIPAL, null)).toBeNull();
  });

  it("loads codemode only on execute", async () => {
    const env = { LOADER: {} } as Env;
    const lazy = createLazyRunCodeTool(env, "user-1", ORCHESTRATOR_PRINCIPAL, "alice@example.test");
    expect(lazy?.execute).toBeDefined();
    const { createRunCodeTool } = await import("../src/codemode.js");
    expect(createRunCodeTool).not.toHaveBeenCalled();
    const out = await lazy!.execute!({ code: "async () => 1" }, {} as never);
    expect(out).toBe("ok");
    expect(createRunCodeTool).toHaveBeenCalledOnce();
  });
});