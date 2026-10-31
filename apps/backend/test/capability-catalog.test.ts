import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Env } from "../src/env.js";
import type { TokenRecord } from "../src/agent-tokens.js";
import {
  BUILTIN_CAPABILITY_SOURCE,
  DEFAULT_CAPABILITY_LIMIT,
  MAX_CAPABILITY_LIMIT,
  MAX_CAPABILITY_SCHEMA_BYTES,
  buildCapabilityDirectory,
  buildCapabilityCatalog,
  projectRegisteredTools,
  registerAllMcpTools,
} from "../src/capability-catalog.js";
import { createToolRegistry } from "../src/mcp-gateway.js";
import type { RegisteredCapabilityTool } from "../src/capability-catalog.js";

const token = (overrides: Partial<TokenRecord> = {}): TokenRecord => ({
  principal: "research-agent", scopes: ["gmail:read", "runs:read"], created: 100, revoked: false,
  kind: "agent", orgId: "self-hosted", ...overrides,
});

describe("built-in capability catalog", () => {
  it("projects the actual registered handlers and filters every entry by the verified token scope", async () => {
    const env = {} as Env;
    const registry = createToolRegistry(env);
    registerAllMcpTools(registry, env);
    const entries = await projectRegisteredTools(registry.tools(), token());

    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry) => entry.allowed && token().scopes.includes(entry.requiredScope))).toBe(true);
    expect(entries.map((entry) => entry.id)).toContain(`${BUILTIN_CAPABILITY_SOURCE}:gmail_search`);
    expect(entries.map((entry) => entry.id)).toContain(`${BUILTIN_CAPABILITY_SOURCE}:run_status`);
    expect(entries.map((entry) => entry.id)).toContain(`${BUILTIN_CAPABILITY_SOURCE}:grokbot_bridge_status`);
    expect(entries.map((entry) => entry.id)).not.toContain(`${BUILTIN_CAPABILITY_SOURCE}:gmail_send`);
    expect(entries.every((entry) => entry.verification === "not_checked" && entry.healthCheck.available === false)).toBe(true);
    expect(entries.find((entry) => entry.name === "gmail_search")?.inputSchema?.type).toBe("object");
  });

  it("excludes API keys, revoked tokens, expired principals, and malformed scopes", async () => {
    const env = {} as Env;
    await expect(buildCapabilityCatalog(env, token({ kind: "api_key" }))).rejects.toThrow(/active MCP agent/);
    await expect(buildCapabilityCatalog(env, token({ revoked: true }))).rejects.toThrow(/active MCP agent/);
    await expect(buildCapabilityCatalog(env, token({ expiresAt: Date.now() - 1 }))).rejects.toThrow(/active MCP agent/);
    await expect(buildCapabilityCatalog(env, token({ scopes: undefined as never }))).rejects.toThrow(/active MCP agent/);
  });

  it("bounds inventory size, selected IDs, and generated JSON schemas", async () => {
    const tools: RegisteredCapabilityTool[] = Array.from({ length: MAX_CAPABILITY_LIMIT + 7 }, (_, index) => ({
      name: `tool_${index}`, scope: "runs:read",
      meta: { description: `Synthetic tool ${index}`, inputSchema: { query: z.string().max(100) } },
    }));
    const limited = await projectRegisteredTools(tools, token({ scopes: ["runs:read"] }));
    expect(limited).toHaveLength(MAX_CAPABILITY_LIMIT + 7);
    const schema = limited[0]?.inputSchema;
    expect(JSON.stringify(schema).length).toBeLessThan(MAX_CAPABILITY_SCHEMA_BYTES);
    const selected = await projectRegisteredTools(tools, token({ scopes: ["runs:read"] }), new Set(["mcp:shiba:tool_1"]));
    expect(selected.map((entry) => entry.name)).toEqual(["tool_1"]);
    expect(DEFAULT_CAPABILITY_LIMIT).toBeLessThanOrEqual(MAX_CAPABILITY_LIMIT);
  });

  it("rejects duplicate namespaced identities instead of silently shadowing them", async () => {
    const duplicate: RegisteredCapabilityTool[] = [
      { name: "same_name", scope: "runs:read", meta: {} },
      { name: "same_name", scope: "runs:read", meta: {} },
    ];
    await expect(projectRegisteredTools(duplicate, token({ scopes: ["runs:read"] }))).rejects.toThrow(/Duplicate capability id/);
  });

  it("does not expose an oversized or invalid schema body", async () => {
    const hugeShape = Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`field_${i}`, z.string()]));
    const result = await projectRegisteredTools([{
      name: "large_tool", scope: "runs:read", meta: { inputSchema: hugeShape as never },
    }], token({ scopes: ["runs:read"] }));
    expect(result[0]?.schemaOmitted).toBe("too_large");
    expect(result[0]?.inputSchema).toBeUndefined();
    expect(result[0]?.schemaVersion).toBe("unavailable");
  });

  it("gives dashboard users bounded public metadata only, with no implied access or schemas", () => {
    const directory = buildCapabilityDirectory({} as Env, { limit: 3 });
    expect(directory.returned).toBe(3);
    expect(directory.truncated).toBe(true);
    expect(directory.liveChecksPerformed).toBe(false);
    expect(directory.entries.every((entry) => entry.allowed === false && entry.verification === "not_checked")).toBe(true);
    expect(directory.entries.some((entry) => "inputSchema" in entry)).toBe(false);
  });
});
