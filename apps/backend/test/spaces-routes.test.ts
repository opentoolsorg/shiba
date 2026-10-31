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

function spacesEnv(db = customAgentD1().database): Env {
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
            return {
              toArray: () => {
                if (/FROM space LIMIT/i.test(statement)) return rows.space ? [rows.space] : [];
                if (/FROM space_items/i.test(statement)) return rows.items;
                return [];
              },
            };
          },
        };
        instances.set(key, new Spaces({ storage: { sql } } as unknown as DurableObjectState));
      }
      return { fetch: (request: Request) => instances.get(key)!.fetch(request) };
    },
  };
  return { REQUIRE_ACCESS: true, AGENT_AUDIT: db, Spaces: namespace } as unknown as Env;
}

beforeEach(() => {
  authState.dashboard = true;
  authState.principal = null;
});

describe("spaces routes", () => {
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
