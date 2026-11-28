import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { createNote } from "../src/notes/notes-store.js";
import { handleNotes } from "../src/notes/notes-routes.js";
import { createTeamWorkspace } from "../src/team-workspaces-store.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

const OWNER = "owner@example.test";
const CREATOR = "creator@example.test";
const MEMBER = "member@example.test";
const state = vi.hoisted(() => ({ userId: "member@example.test", workspaceId: "" }));

vi.mock("../src/request-auth.js", () => ({
  resolveRequestIdentity: async () => ({ authorized: true, userId: state.userId }),
  requireSameOriginBrowserMutation: () => null,
}));
vi.mock("../src/org-request-auth.js", () => ({
  resolveOrgForApiRequest: async () => ({
    workspace: { workspaceId: state.workspaceId, userId: state.userId, role: "member", version: 1, joinedAt: 1 },
  }),
}));

function patchRequest(noteId: string) {
  return new Request(`https://shiba.test/api/notes/${noteId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ markdown: "changed", expectedVersion: 1 }),
  });
}

describe("note write authority", () => {
  beforeEach(() => { state.userId = MEMBER; });

  it("rejects a member overwriting another member's shared note but allows its creator", async () => {
    const { database, sqlite } = customAgentD1();
    const objects = new Map<string, Uint8Array>();
    const env = {
      AGENT_AUDIT: database,
      INGEST_QUEUE: { send: async () => undefined },
      FILES: {
        put: async (key: string, bytes: Uint8Array) => { objects.set(key, bytes); return {}; },
        get: async (key: string) => {
          const bytes = objects.get(key);
          return bytes ? { arrayBuffer: async () => bytes.buffer } : null;
        },
      },
    } as unknown as Env;
    const workspace = await createTeamWorkspace(env, OWNER, { name: "Knowledge" }, 1);
    state.workspaceId = workspace.workspaceId;
    for (const [userId, joinedAt] of [[CREATOR, 2], [MEMBER, 3]] as const) {
      sqlite.prepare(`INSERT INTO team_workspace_memberships(tenant_id,workspace_id,user_id,role,status,version,joined_at)
        VALUES('self-hosted',?,?, 'member','active',1,?)`).run(workspace.workspaceId, userId, joinedAt);
    }
    const note = await createNote(env, {
      workspaceId: workspace.workspaceId,
      scope: "workspace",
      title: "Shared brief",
      markdown: "original",
      createdBy: CREATOR,
    });

    expect((await handleNotes(patchRequest(note.id), env))?.status).toBe(403);
    state.userId = CREATOR;
    expect((await handleNotes(patchRequest(note.id), env))?.status).toBe(200);
  });
});
