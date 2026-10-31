import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { Spaces } from "../src/spaces-do.js";
import { handleSkills } from "../src/skills-routes.js";
import { handleSpaces } from "../src/spaces-routes.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

const authState = vi.hoisted(() => ({
  dashboard: false,
  principal: null as null | { principal: string; orgId: string; scopes: string[] },
}));

vi.mock("../src/request-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/request-auth.js")>();
  return { ...actual, isAuthorizedRequest: vi.fn(async () => authState.dashboard) };
});

vi.mock("../src/v1-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/v1-auth.js")>();
  return { ...actual, authorizeV1Request: vi.fn(async () => authState.principal) };
});

const headers = (user = "owner@example.test") => ({
  "CF-Access-Authenticated-User-Email": user,
  "content-type": "application/json",
});

function spacesEnv(db = customAgentD1().database, intercept?: (request: Request) => Response | undefined): Env {
  const instances = new Map<string, Spaces>();
  const namespace = {
    idFromName: (name: string) => ({ toString: () => name }),
    get: (id: { toString: () => string }) => {
      const key = id.toString();
      if (!instances.has(key)) {
        const rows: {
          space: Record<string, unknown> | null;
          items: Array<{ kind: string; ref: string; added_at: number }>;
        } = { space: null, items: [] };
        const sql = {
          exec: (statement: string, ...args: unknown[]) => {
            if (/INSERT INTO space \(/i.test(statement)) {
              rows.space = {
                id: args[0], org_id: args[1], name: args[2], template: args[3], created_by: args[4], created_at: args[5], updated_at: args[6],
              };
            }
            if (/INSERT INTO space_items/i.test(statement)) {
              rows.items.push({ kind: String(args[0]), ref: String(args[1]), added_at: Number(args[2]) });
            }
            if (/DELETE FROM space_items/i.test(statement)) rows.items = [];
            if (/DELETE FROM space$/i.test(statement)) rows.space = null;
            return {
              toArray: () => {
                if (/FROM space LIMIT/i.test(statement)) return rows.space ? [rows.space] : [];
                if (/FROM space_items/i.test(statement)) return rows.items;
                return [];
              },
            };
          },
        };
        instances.set(key, new Spaces({ storage: { sql, transactionSync: (callback: () => unknown) => callback() } } as unknown as DurableObjectState));
      }
      return { fetch: (request: Request) => intercept?.(request) ?? instances.get(key)!.fetch(request) };
    },
  };
  return { REQUIRE_ACCESS: true, AGENT_AUDIT: db, Spaces: namespace } as unknown as Env;
}

beforeEach(() => {
  authState.dashboard = true;
  authState.principal = null;
});

describe("spaces routes", () => {
  const createRequest = (template = "blank") => new Request("https://shiba.test/api/spaces", {
    method: "POST", headers: headers(), body: JSON.stringify({ name: "Temp", template }),
  });

  it.each(["throw", "non-ok"])("cleans up a partial template after a %s item failure", async (failure) => {
    const { database, sqlite } = customAgentD1();
    const paths: string[] = [];
    const bindings = spacesEnv(database, (request) => {
      const path = new URL(request.url).pathname;
      paths.push(path);
      if (path === "/internal/items") {
        if (failure === "throw") throw new Error("item unavailable");
        return Response.json({ error: "unavailable" }, { status: 503 });
      }
      return undefined;
    });
    const response = await handleSpaces(createRequest("code-review"), bindings);
    expect(response?.status).toBe(502);
    expect(await response!.json()).toEqual({ ok: false, error: "space_template_failed" });
    expect(paths).toContain("/internal/destroy");
    expect(sqlite.prepare("SELECT * FROM spaces_index").all()).toEqual([]);
  });

  it("keeps partial creation indexed when erasure fails so it can be deleted later", async () => {
    const { database, sqlite } = customAgentD1();
    const bindings = spacesEnv(database, (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/internal/items" || path === "/internal/destroy") {
        return Response.json({ error: "unavailable" }, { status: 503 });
      }
      return undefined;
    });
    const response = await handleSpaces(createRequest("code-review"), bindings);
    expect(response?.status).toBe(502);
    const body = await response!.json() as { error: string; id: string };
    expect(body.error).toBe("space_create_cleanup_failed");
    expect(sqlite.prepare("SELECT id FROM spaces_index").all()).toEqual([{ id: body.id }]);
  });

  it.each(["throw", "non-ok"])("keeps the index after a %s destroy failure and allows retry", async (failure) => {
    const { database, sqlite } = customAgentD1();
    let fail = true;
    const bindings = spacesEnv(database, (request) => {
      if (fail && new URL(request.url).pathname === "/internal/destroy") {
        if (failure === "throw") throw new Error("DO unavailable");
        return Response.json({ error: "unavailable" }, { status: 503 });
      }
      return undefined;
    });
    const created = await handleSpaces(createRequest(), bindings);
    const { space } = await created!.json() as { space: { id: string } };
    const deleteRequest = () => new Request(`https://shiba.test/api/spaces/${space.id}`, { method: "DELETE", headers: headers() });
    const failed = await handleSpaces(deleteRequest(), bindings);
    expect(failed?.status).toBe(502);
    expect(await failed!.json()).toEqual({ ok: false, error: "space_destroy_failed" });
    expect(sqlite.prepare("SELECT id FROM spaces_index").all()).toEqual([{ id: space.id }]);
    fail = false;
    expect((await handleSpaces(deleteRequest(), bindings))?.status).toBe(200);
    expect(sqlite.prepare("SELECT id FROM spaces_index").all()).toEqual([]);
  });

  it.each([123456789, undefined])("touches the index with item time %s or a current-time fallback", async (addedAt) => {
    const { database, sqlite } = customAgentD1();
    const bindings = spacesEnv(database, (request) => {
      if (new URL(request.url).pathname === "/internal/items") {
        return Response.json({ ok: true, item: { kind: "repo", ref: "org/repo", addedAt } });
      }
      return undefined;
    });
    const created = await handleSpaces(createRequest(), bindings);
    const { space } = await created!.json() as { space: { id: string } };
    const before = Date.now();
    const response = await handleSpaces(new Request(`https://shiba.test/api/spaces/${space.id}/items`, {
      method: "POST", headers: headers(), body: JSON.stringify({ kind: "repo", ref: "org/repo" }),
    }), bindings);
    expect(response?.status).toBe(200);
    const row = sqlite.prepare("SELECT updated_at FROM spaces_index WHERE id = ?").get(space.id) as { updated_at: number };
    if (addedAt !== undefined) expect(row.updated_at).toBe(addedAt);
    else {
      expect(row.updated_at).toBeGreaterThanOrEqual(before);
      expect(row.updated_at).toBeLessThanOrEqual(Date.now());
    }
  });

  it("leaves the index timestamp unchanged when adding an invalid item fails", async () => {
    const { database, sqlite } = customAgentD1();
    const bindings = spacesEnv(database);
    const created = await handleSpaces(createRequest(), bindings);
    const { space } = await created?.json() as { space: { id: string } };
    sqlite.prepare("UPDATE spaces_index SET updated_at = 100 WHERE id = ?").run(space.id);
    const response = await handleSpaces(new Request(`https://shiba.test/api/spaces/${space.id}/items`, {
      method: "POST", headers: headers(), body: JSON.stringify({ kind: "repo", ref: "" }),
    }), bindings);
    expect(response?.status).toBe(400);
    expect(sqlite.prepare("SELECT updated_at FROM spaces_index WHERE id = ?").get(space.id)).toEqual({ updated_at: 100 });
  });

  it("creates a code-review space with draft skill items and blocks cross-org reads", async () => {
    const bindings = spacesEnv();
    authState.dashboard = false;
    authState.principal = { principal: "owner-a", orgId: "org-a", scopes: ["api:read", "api:write"] };
    const create = await handleSpaces(new Request("https://shiba.test/api/spaces", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ name: "Review desk", template: "code-review" }),
    }), bindings);
    expect(create?.status).toBe(201);
    const created = await create!.json() as { space: { id: string; items: Array<{ kind: string; ref: string }> } };
    expect(created.space.items.filter((item) => item.kind === "skill")).toHaveLength(2);

    authState.principal = { principal: "owner-a", orgId: "org-a", scopes: ["api:read", "api:write"] };
    const list = await handleSkills(new Request("https://shiba.test/api/skills", { headers: headers("owner-a") }), bindings);
    const listed = await list!.json() as { skills: Array<{ status: string }> };
    expect(listed.skills.filter((skill) => skill.status === "draft").length).toBeGreaterThanOrEqual(2);

    authState.principal = { principal: "owner-b", orgId: "org-b", scopes: ["api:read", "api:write"] };
    expect((await handleSpaces(new Request(`https://shiba.test/api/spaces/${created.space.id}`, { headers: headers() }), bindings))?.status).toBe(404);
  });

  it("rejects unknown templates and deletes spaces from the index", async () => {
    const bindings = spacesEnv();
    authState.dashboard = false;
    authState.principal = { principal: "owner-a", orgId: "org-a", scopes: ["api:read", "api:write"] };
    expect((await handleSpaces(new Request("https://shiba.test/api/spaces", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ name: "Bad", template: "not-real" }),
    }), bindings))?.status).toBe(400);

    const create = await handleSpaces(new Request("https://shiba.test/api/spaces", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ name: "Temp", template: "blank" }),
    }), bindings);
    const { space } = await create!.json() as { space: { id: string } };
    expect((await handleSpaces(new Request(`https://shiba.test/api/spaces/${space.id}`, { method: "DELETE", headers: headers() }), bindings))?.status).toBe(200);
    expect((await handleSpaces(new Request(`https://shiba.test/api/spaces/${space.id}`, { headers: headers() }), bindings))?.status).toBe(404);
  });
});
