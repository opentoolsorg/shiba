import { beforeEach, describe, expect, it } from "vitest";
import type { V1Principal } from "../src/v1-auth.js";
import type { Env } from "../src/env.js";
import { handleV1 } from "../src/v1-routes.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

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

describe("Overlay-compatible extension skills routes", () => {
  it("creates, lists by scope, edits with versions, toggles, archives, and restores", async () => {
    const f = fixture();
    const create = await f.send(base, "POST", {
      name: "Writing",
      description: "Concise writing",
      instructions: "Use short paragraphs.",
      enabled: false,
    });
    expect(create?.status).toBe(201);
    const { id } = await create!.json() as { id: string };
    expect(id).toMatch(/^skill_/);

    const listed = await f.send(base);
    expect(await listed?.json()).toMatchObject([{
      _id: id,
      userId: "alice",
      workspaceId: "workspace-1",
      name: "Writing",
      enabled: false,
      version: 1,
      scope: "personal",
    }]);

    const edited = await f.send(`${base}/${id}`, "PATCH", { instructions: "Use compact paragraphs." });
    expect(await edited?.json()).toEqual({ success: true });
    expect(await (await f.send(`${base}/${id}`))?.json()).toMatchObject({ version: 2, instructions: "Use compact paragraphs." });
    await f.send(`${base}/${id}`, "PATCH", { enabled: true });
    expect(await (await f.send(`${base}/${id}`))?.json()).toMatchObject({ version: 2, enabled: true });

    expect((await f.send(`${base}/${id}/scope`, "POST", { to: "workspace" }))?.status).toBe(200);
    expect(await (await f.send(`${base}?view=personal`))?.json()).toEqual([]);
    expect(await (await f.send(`${base}?view=workspace`))?.json()).toMatchObject([{ _id: id, scope: "workspace" }]);

    expect((await f.send(`${base}/${id}/archive`, "POST"))?.status).toBe(200);
    expect(await (await f.send(`${base}?view=workspace`))?.json()).toEqual([]);
    expect(await (await f.send(`${base}?view=archived`))?.json()).toMatchObject([{ _id: id, archivedFromScope: "workspace" }]);
    expect((await f.send(`${base}/${id}/restore`, "POST"))?.status).toBe(200);
    const restored = await (await f.send(`${base}/${id}`))?.json() as Record<string, unknown>;
    expect(restored.scope).toBe("workspace");
    expect(restored).not.toHaveProperty("archivedAt");
  });

  it("shares only workspace rows, keeps instruction bodies out of the directory, and loads instructions on demand", async () => {
    const f = fixture();
    const personalResponse = await f.send(base, "POST", { name: "Private", description: "Mine", instructions: "Private body" });
    const personalId = (await personalResponse!.json() as { id: string }).id;
    const sharedResponse = await f.send(base, "POST", {
      name: "Shared",
      description: "Workspace policy",
      instructions: "Shared body",
      scope: "workspace",
    });
    const sharedId = (await sharedResponse!.json() as { id: string }).id;

    f.setPrincipal({ principal: "bob", orgId: "workspace-1", scopes: ["api:read", "api:write"] });
    expect(await (await f.send(base))?.json()).toMatchObject([{ _id: sharedId, name: "Shared" }]);
    expect((await f.send(`${base}/${personalId}`))?.status).toBe(404);
    const directoryResponse = await f.send(`${base}/directory`);
    const directory = await directoryResponse?.json() as Array<Record<string, unknown>>;
    expect(directory).toEqual([{ _id: sharedId, name: "Shared", description: "Workspace policy", enabled: true }]);
    expect(JSON.stringify(directory)).not.toContain("Shared body");
    expect(await (await f.send(`${base}/${sharedId}/instructions`))?.json()).toEqual({
      _id: sharedId,
      name: "Shared",
      instructions: "Shared body",
    });
    expect((await f.send(`${base}/${sharedId}`, "PATCH", { name: "Hijack" }))?.status).toBe(403);
    expect((await f.send(`${base}/${sharedId}/archive`, "POST"))?.status).toBe(403);
    expect(await (await f.send(base))?.json()).toMatchObject([{ _id: sharedId, permissions: { canEdit: false, canMove: false, canArchive: false, canRestore: false, canDelete: false } }]);

    f.setPrincipal({ principal: "admin", orgId: "workspace-1", scopes: ["api:read", "api:write", "api:keys:admin"] });
    expect(await (await f.send(base))?.json()).toMatchObject([{ _id: sharedId, permissions: { canEdit: true, canMove: false, canArchive: true, canDelete: true } }]);
    expect((await f.send(`${base}/${sharedId}`, "PATCH", { name: "Admin edit" }))?.status).toBe(200);
    expect((await f.send(`${base}/${sharedId}/archive`, "POST"))?.status).toBe(200);
    expect((await f.send(`${base}/${sharedId}/restore`, "POST"))?.status).toBe(200);

    f.setPrincipal({ principal: "bob", orgId: "workspace-2", scopes: ["api:read", "api:write"] });
    expect(await (await f.send(base))?.json()).toEqual([]);
    expect(await (await f.send(`${base}/${sharedId}/instructions`))?.json()).toBeNull();
  });

  it("accepts read-only access but applies the v1 write-scope gate before mutations", async () => {
    const f = fixture();
    f.setPrincipal({ principal: "reader", orgId: "workspace-1", scopes: ["api:read"] });
    expect((await f.send(base, "POST", { name: "No", description: "No", instructions: "No" }))?.status).toBe(403);
    expect((await f.send(base))?.status).toBe(200);
    expect((await f.send(`${base}/missing`, "DELETE"))?.status).toBe(403);
  });

  it("rejects cross-origin session mutations", async () => {
    const f = fixture();
    expect((await f.send(base, "POST", { name: "No", description: "No", instructions: "No" }, "https://attacker.test"))?.status).toBe(403);
    expect((await f.send(base, "POST", { name: "No", description: "No", instructions: "No" }, "https://shiba.test", "text/plain"))?.status).toBe(415);
  });
});
