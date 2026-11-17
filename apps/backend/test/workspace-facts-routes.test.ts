import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { handleWorkspaceFacts } from "../src/workspace-facts-routes.js";
import { WorkspaceChannelFactsStore } from "../src/workspace-channel-facts.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

const PATH = "/api/admin/workspace-facts";
const scope = { teamId: "T1", connectionId: "legacy" };
const meta = { createdBy: "employee-1", sourceChannel: "C1" };
function request(path = PATH, method = "GET", host = "http://localhost") {
  return new Request(`${host}${path}`, { method, headers: { Origin: host } });
}
function fixture() {
  const f = customAgentD1({ bare: true });
  f.sqlite.exec(readFileSync(new URL("../migrations/0063_workspace_channel_facts.sql", import.meta.url), "utf8"));
  return { ...f, env: { AGENT_AUDIT: f.database } as Env, store: new WorkspaceChannelFactsStore(f.database) };
}

describe("operator workspace facts routes", () => {
  it("refuses non-operators for both list and delete before accessing storage", async () => {
    const env = {} as Env;
    for (const [path, method] of [[PATH, "GET"], [`${PATH}/any`, "DELETE"]]) {
      const req = request(path, method, "https://worker.test");
      req.headers.set("Authorization", "Bearer dashboard-key");
      const response = await handleWorkspaceFacts(req, env);
      expect(response?.status).toBe(403);
      expect(await response?.json()).toEqual({ error: "Deployment operator required." });
    }
  });

  it("lists all teams and connections with metadata, including an empty list", async () => {
    const f = fixture();
    try {
      expect(await (await handleWorkspaceFacts(request(), f.env))?.json()).toEqual({ facts: [] });
      const a = await f.store.remember(scope, "Alex owns billing", meta);
      const b = await f.store.remember({ teamId: "T2", connectionId: "revoked-connection" }, "Maya owns search", meta);
      const response = await handleWorkspaceFacts(request(), f.env);
      expect(response?.status).toBe(200);
      expect(response?.headers.get("Cache-Control")).toBe("no-store");
      expect(await response?.json()).toEqual({ facts: expect.arrayContaining([a, b]) });
    } finally { f.sqlite.close(); }
  });

  it("deletes by id across connections and returns 404 for an unknown id", async () => {
    const f = fixture();
    try {
      const fact = await f.store.remember(scope, "Remove me", meta);
      const kept = await f.store.remember({ ...scope, connectionId: "other" }, "Keep me", meta);
      const response = await handleWorkspaceFacts(request(`${PATH}/${fact.id}`, "DELETE"), f.env);
      expect(response?.status).toBe(200);
      expect(await response?.json()).toEqual({ deleted: true });
      expect(await f.store.listAll()).toEqual([kept]);
      expect((await handleWorkspaceFacts(request(`${PATH}/${fact.id}`, "DELETE"), f.env))?.status).toBe(404);
    } finally { f.sqlite.close(); }
  });

  it("requires same-origin deletion, handles malformed ids and missing storage, and ignores other routes", async () => {
    const f = fixture();
    try {
      const fact = await f.store.remember(scope, "Keep me", meta);
      const crossOrigin = request(`${PATH}/${fact.id}`, "DELETE");
      crossOrigin.headers.set("Origin", "https://other.test");
      expect((await handleWorkspaceFacts(crossOrigin, f.env))?.status).toBe(403);
      expect(await f.store.listAll()).toHaveLength(1);
      expect((await handleWorkspaceFacts(request(`${PATH}/%zz`, "DELETE"), f.env))?.status).toBe(400);
      expect((await handleWorkspaceFacts(request(), {} as Env))?.status).toBe(503);
      expect(await handleWorkspaceFacts(request("/api/other"), f.env)).toBeNull();
    } finally { f.sqlite.close(); }
  });
});
