import { describe, expect, it } from "vitest";
import type { V1Principal } from "../src/v1-auth.js";
import type { Env } from "../src/env.js";
import { handleV1 } from "../src/v1-routes.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import {
  DEFAULT_EXTENSION_SCOPE_POLICY,
  setScope,
  type ExtensionScopeRole,
} from "@shiba/shared";

const fixture = () => {
  const { database } = customAgentD1();
  let principal: V1Principal = { principal: "alice", orgId: "workspace-1", scopes: ["api:read", "api:write"] };
  const env = { AGENT_AUDIT: database } as unknown as Env;
  const send = (path: string, method = "GET", body?: unknown, origin = "https://shiba.test", contentType = "application/json") => handleV1(
    new Request(`https://shiba.test${path}`, {
      method,
      headers: { "content-type": contentType, origin },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
    { authorize: async () => principal },
  );
  return { send, setPrincipal(value: V1Principal) { principal = value; } };
};

const base = "/api/v1/extensions/skills";

describe("extension skills scope policy", () => {
  it("blocks members from moving to workspace when workspace editors are admins-only", () => {
    const row = { id: "skill-1", userId: "alice", workspaceId: "ws-1", scope: "personal" as const };
    const actor = { userId: "alice", role: "member" as ExtensionScopeRole, policy: { ...DEFAULT_EXTENSION_SCOPE_POLICY, workspaceExtensionsEditors: "admins" as const } };
    expect(setScope(row, "workspace", actor)).toEqual({ ok: false, reason: "workspace_creation_restricted" });
    expect(setScope(row, "workspace", { ...actor, role: "admin" })).toEqual({ ok: true, patch: { scope: "workspace" } });
  });

  it("move, archive, restore through routes with version conflicts", async () => {
    const f = fixture();
    const create = await f.send(base, "POST", { name: "Notes", description: "Shared", instructions: "Body v1", enabled: false });
    const { id } = await create!.json() as { id: string };
    expect((await f.send(`${base}/${id}/scope`, "POST", { to: "workspace" }))?.status).toBe(200);
    f.setPrincipal({ principal: "bob", orgId: "workspace-1", scopes: ["api:read", "api:write"] });
    expect(await (await f.send(`${base}?view=workspace`))?.json()).toMatchObject([{ _id: id }]);
    f.setPrincipal({ principal: "alice", orgId: "workspace-1", scopes: ["api:read", "api:write"] });
    expect((await f.send(`${base}/${id}`, "PATCH", { instructions: "Body v2", expectedVersion: 99 }))?.status).toBe(409);
    expect((await f.send(`${base}/${id}/archive`, "POST"))?.status).toBe(200);
    f.setPrincipal({ principal: "bob", orgId: "workspace-1", scopes: ["api:read", "api:write"] });
    expect(await (await f.send(`${base}?view=workspace`))?.json()).toEqual([]);
    expect((await f.send(`${base}/${id}/restore`, "POST"))?.status).toBe(403);
    f.setPrincipal({ principal: "alice", orgId: "workspace-1", scopes: ["api:read", "api:write", "api:keys:admin"] });
    expect((await f.send(`${base}/${id}/restore`, "POST"))?.status).toBe(200);
  });
});