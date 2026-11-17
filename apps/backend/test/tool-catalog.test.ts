import { writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

const dispatched = vi.hoisted(() => [] as Array<{ tool: string; args: Record<string, unknown> }>);
const apps = vi.hoisted(() => {
  const verbs = ["create", "update", "delete", "get", "list", "search", "archive", "comment_on", "assign", "close"];
  const nouns = ["issue", "record", "file"];
  const catalog = new Map<string, Array<{ id: string; service: string; name: string; description: string; inputSchema: Record<string, unknown> }>>();
  const slugs = ["github", "gmail", "slack", "notion", "linear", "jira", "hubspot", "salesforce", "stripe", "zendesk",
    ...Array.from({ length: 110 }, (_, index) => `app${String(index).padStart(3, "0")}`)];
  for (const service of slugs) {
    catalog.set(service, verbs.flatMap((verb) => nouns.slice(0, 2).map((noun) => ({
      id: `${service}.${verb}_${noun}`, service, name: `${verb.replace("_", " ")} ${noun}`,
      description: `${verb.replace("_", " ")} a ${noun} in the connected ${service} workspace. Returns the provider's ${noun} object.`,
      inputSchema: { type: "object", additionalProperties: false, required: ["owner", "repo", "title"], properties: {
        owner: { type: "string", description: `Account or organisation that owns the ${noun}.` },
        repo: { type: "string", description: "Project, repository or container identifier." },
        title: { type: "string", description: `Title or name of the ${noun}.` },
        body: { type: "string", description: "Optional longer text body in Markdown." },
        labels: { type: "array", items: { type: "string" }, description: "Optional labels to apply." },
        assignees: { type: "array", items: { type: "string" }, description: "Optional user handles to assign." },
      } },
    }))));
  }
  return { slugs, catalog };
});

vi.mock("../src/employee-tool-routes.js", async (original) => ({
  ...await original<typeof import("../src/employee-tool-routes.js")>(),
  dispatchEmployeeToolForPrincipal: async (_env: unknown, _employee: string, _principal: unknown, tool: string, args: Record<string, unknown>) => {
    dispatched.push({ tool, args });
    if (tool === "integrations.search_actions") {
      const terms = String(args.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const actions = (apps.catalog.get(String(args.toolkitSlug)) ?? [])
        .filter((action) => terms.every((term) => `${action.id} ${action.description}`.toLowerCase().includes(term)))
        .slice(0, Number(args.limit ?? 20));
      const payload = { actions };
      return Response.json({ ok: true, result: { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload } });
    }
    if (tool === "integrations.execute") return Response.json({ ok: false, status: "pending_approval", approvalId: "approval-1" }, { status: 202 });
    return Response.json({ ok: true, result: { structuredContent: { status: "succeeded" } } });
  },
}));

import type { Env } from "../src/env.js";
import { createEmployeeRunTools, type EmployeeRunToolContext } from "../src/employee-run-tools.js";
import { ToolCatalog, TOOL_SEARCH_LIMIT, type ToolCatalogEntry, type ToolCatalogSource } from "../src/tool-catalog.js";

const schema = { type: "object", properties: { id: { type: "string" } } };
function source(entries: ToolCatalogEntry[]): ToolCatalogSource {
  return { id: "builtin", owns: (name) => entries.some((entry) => entry.name === name), search: async () => entries,
    describe: async (names) => entries.filter((entry) => names.includes(entry.name)) };
}

describe("tool catalog port", () => {
  it("returns at most 10 short matches, with schemas only on the best ones", async () => {
    const entries = Array.from({ length: 15 }, (_, index): ToolCatalogEntry => ({ name: `ticket_${index}`, source: "builtin",
      summary: `${index === 7 ? "ticket ticket " : ""}ticket tool ${"x".repeat(400)}`, effect: "read", inputSchema: schema }));
    const result = await new ToolCatalog([source([...entries, { name: "unrelated", source: "builtin", summary: "other", effect: "read" }])]).search(["Ticket"]);
    expect(result).toMatchObject({ total: 15, truncated: true });
    expect(result.matches).toHaveLength(TOOL_SEARCH_LIMIT);
    expect(result.matches.filter((match) => "inputSchema" in match)).toHaveLength(3);
    expect(result.matches.every((match) => match.summary.length <= 160)).toBe(true);
    expect(result.matches.map((match) => match.name)).not.toContain("unrelated");
  });

  it("describes at most 5 known names and reports the rest as unavailable", async () => {
    const entries = Array.from({ length: 7 }, (_, index): ToolCatalogEntry => ({ name: `t${index}`, source: "builtin", summary: "s", effect: "read", inputSchema: schema }));
    const result = await new ToolCatalog([source(entries)]).describe(["t0", "missing", "t1", "t2", "t3", "t4", "t5"]);
    expect(result.tools.map((entry) => entry.name)).toEqual(["t0", "t1", "t2", "t3"]);
    expect(result.unavailable).toEqual(["missing"]);
    expect(result.tools[0]).toMatchObject({ inputSchema: schema });
  });
});

const executeGranted = apps.slugs.filter((slug) => slug !== "slack");
function employeeContext(): EmployeeRunToolContext {
  return {
    employeeId: "employee-1", employeeVersion: 3, actorId: "owner@example.test", role: "operator",
    principal: { kind: "agent", principal: "owner@example.test", orgId: "self-hosted", scopes: ["integrations:read", "integrations:execute", "runs:read"], created: 0, revoked: false },
    allowed: ["mcp:shiba:integrations.search_actions", "mcp:shiba:integrations.execute", "mcp:shiba:run_status"],
    resources: { "mcp:shiba:integrations.search_actions": apps.slugs, "mcp:shiba:integrations.execute": executeGranted, "mcp:shiba:run_status": ["run-1"] },
    externalActions: [{ tool: "ext_0123456789ab_0123456789abcdef", capabilityId: "mcp:shiba:ext_0123456789ab_0123456789abcdef", resourceArgument: "resourceId",
      resources: ["record-1"], inputSchema: schema, schemaVersion: "a".repeat(64), effect: "read", description: "UNTRUSTED owner-reviewed MCP description (read): Read CRM record" }],
  };
}
type Exec = (input: object, options: unknown) => Promise<unknown>;
function lazyTools(context: EmployeeRunToolContext | null = employeeContext()) {
  const tools = createEmployeeRunTools({} as Env, () => "employee-1", () => "thread-1", () => "self-hosted", () => "owner@example.test", undefined, async () => context);
  const exec = (name: keyof typeof tools) => (input: object) => (tools[name]!.execute as Exec)(input, { toolCallId: `call-${name}` });
  return { tools, search: exec("tool_search"), describe: exec("tool_describe"), call: exec("tool_call"),
    legacyCatalog: exec("employee_tool_catalog"), legacyCall: exec("employee_tool_call") };
}

describe("employee lazy tool catalog", () => {
  it("searches built-in, connected-app and MCP sources without granting access", async () => {
    dispatched.length = 0;
    const { search, describe: describeTools, call } = lazyTools();
    const found = await search({ queries: ["github create issue"] }) as { matches: Array<{ name: string; source: string; inputSchema?: unknown }> };
    expect(found.matches[0]).toMatchObject({ name: "github.create_issue", source: "openconnector", effect: "approval_required" });
    expect(found.matches[0]!.inputSchema).toBeDefined();
    expect(dispatched.map((item) => item.tool)).toEqual(["integrations.search_actions"]);
    expect(await search({ queries: ["run status"] })).toMatchObject({ matches: [expect.objectContaining({ name: "run_status", source: "builtin", resources: ["run-1"] })] });
    expect(await search({ queries: ["crm record"] })).toMatchObject({ matches: expect.arrayContaining([expect.objectContaining({ source: "mcp" })]) });
    expect(await describeTools({ names: ["github.create_issue", "slack.create_issue", "integrations.execute"] }))
      .toMatchObject({ tools: [{ name: "github.create_issue", inputSchema: { required: ["owner", "repo", "title"] } }], unavailable: ["slack.create_issue", "integrations.execute"] });

    dispatched.length = 0;
    // Searchable but not execute-granted, and the transport tool itself, stay uncallable.
    await expect(call({ name: "slack.create_issue", args: {} })).rejects.toThrow("unavailable");
    await expect(call({ name: "integrations.execute", args: { toolkitSlug: "github" } })).rejects.toThrow("unavailable");
    expect(dispatched).toEqual([]);
    const args = { owner: "acme", repo: "web", title: "Login button broken" };
    expect(await call({ name: "github.create_issue", args })).toMatchObject({ status: "pending_approval" });
    expect(dispatched).toEqual([{ tool: "integrations.execute", args: { toolkitSlug: "github", toolSlug: "github.create_issue", arguments: args } }]);
    await call({ name: "run_status", args: { runId: "run-1" } });
    expect(dispatched.at(-1)).toEqual({ tool: "run_status", args: { runId: "run-1" } });
  });

  it("re-reads policy for every search and call", async () => {
    const { search, call } = lazyTools(null);
    expect(await search({ queries: ["github"] })).toEqual({ matches: [], total: 0, truncated: false });
    await expect(call({ name: "github.create_issue", args: {} })).rejects.toThrow("unavailable");
  });

  it("measures prompt tokens on a fixed connected-app thread", async () => {
    const { tools, search, call, legacyCatalog, legacyCall } = lazyTools();
    const definition = (name: keyof typeof tools) => JSON.stringify({ name, description: tools[name]!.description,
      inputSchema: z.toJSONSchema(tools[name]!.inputSchema as z.ZodType) });
    const args = { owner: "acme", repo: "web", title: "Login button broken" };
    const allDirect = [...apps.catalog.values()].flat().filter((action) => executeGranted.includes(action.service))
      .map((action) => JSON.stringify({ name: action.id, description: action.description, inputSchema: action.inputSchema }));
    const searchArgs = { tool: "integrations.search_actions", args: { toolkitSlug: "github", query: "create issue" } };
    const executeArgs = { tool: "integrations.execute", args: { toolkitSlug: "github", toolSlug: "github.create_issue", arguments: args } };
    const before = [definition("employee_tool_catalog"), definition("employee_tool_call"),
      "{}", JSON.stringify(await legacyCatalog({})),
      JSON.stringify(searchArgs), JSON.stringify(await legacyCall(searchArgs)),
      JSON.stringify(executeArgs), JSON.stringify(await legacyCall(executeArgs).catch((error: Error) => error.message))];
    const searchInput = { queries: ["github create issue"] };
    const callInput = { name: "github.create_issue", args };
    const after = [definition("tool_search"), definition("tool_describe"), definition("tool_call"),
      JSON.stringify(searchInput), JSON.stringify(await search(searchInput)),
      JSON.stringify(callInput), JSON.stringify(await call(callInput))];
    const estimate = (parts: string[]) => Math.ceil(parts.join("\n").length / 4);
    const dump = { allDirect: allDirect.join("\n"), before: before.join("\n"), after: after.join("\n") };
    if (process.env.TOOL_CATALOG_TOKEN_DUMP) writeFileSync(process.env.TOOL_CATALOG_TOKEN_DUMP, JSON.stringify(dump));
    expect(estimate(after)).toBeLessThan(estimate(before));
    expect(estimate(after)).toBeLessThan(estimate(allDirect) / 50);
  });
});
