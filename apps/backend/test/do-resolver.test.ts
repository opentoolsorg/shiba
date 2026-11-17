import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { automationsNameFor, localDispatchNameFor, orchestratorNameFor } from "../src/platform/do-resolver.js";

describe("Durable Object names", () => {
  it("preserves legacy names unless scoped addressing is enabled", () => {
    const env = { SHIBA_SCOPED_DO: "0" };
    expect(orchestratorNameFor(env, { workspaceId: "ws-a", threadKey: "thread-a" })).toBe("default");
    expect(automationsNameFor(env, { workspaceId: "ws-a" })).toBe("default");
    expect(localDispatchNameFor(env, { ownerId: "owner-a" })).toBe("local-dispatch");
  });

  it("uses workspace, thread, and device scopes when enabled", () => {
    const env = { SHIBA_SCOPED_DO: "1" };
    expect(orchestratorNameFor(env, { workspaceId: "ws-a" })).toBe("ws:ws-a");
    expect(orchestratorNameFor(env, { workspaceId: "ws-a", threadKey: "slack:t:c:1" })).toBe("ws:ws-a:thread:slack%3At%3Ac%3A1");
    expect(automationsNameFor(env, { workspaceId: "ws-a" })).toBe("ws:ws-a");
    expect(localDispatchNameFor(env, { ownerId: "device-a" })).toBe("dev:device-a");
  });

  it("cannot confuse a workspace component with a thread boundary", () => {
    const env = { SHIBA_SCOPED_DO: "1" };
    expect(orchestratorNameFor(env, { workspaceId: "a:thread:b" }))
      .not.toBe(orchestratorNameFor(env, { workspaceId: "a", threadKey: "b" }));
    expect(orchestratorNameFor(env, {})).toBe("ws:self-hosted");
  });

  it("keeps direct default name addressing inside the resolver", () => {
    const sourceRoot = new URL("../src/", import.meta.url);
    const collect = (directory: URL): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
      return entry.isDirectory() ? collect(child) : [child.pathname];
    });
    const files = collect(sourceRoot);
    const matches = files.flatMap((file) => {
      const text = readFileSync(file, "utf8");
      return /idFromName\(\s*["']default["']\s*\)/.test(text) && !file.endsWith("/platform/do-resolver.ts") ? [file] : [];
    });
    expect(matches).toEqual([]);
  });
});
