import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import {
  COLLAB_MEMORY_MAX_NOTES,
  createCollaborationMemory,
  listCollaborationMemory,
  revokeCollaborationMemory,
  snapshotCollaborationMemory,
  type CollaborationMemoryNote,
} from "../src/collaboration-memory.js";
import {
  addCollaborationMember, createCollaborationRoom, humanActorId, removeCollaborationMember,
  type CollaborationScope,
} from "../src/collaboration-store.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

const owner: CollaborationScope = { tenantId: "self-hosted", workspaceId: "default", userId: "alice@example.test" };
const member: CollaborationScope = { ...owner, userId: "bob@example.test" };

async function fixture() {
  const { database, sqlite } = customAgentD1();
  const env = { AGENT_AUDIT: database } as unknown as Env;
  await createCollaborationRoom(env, owner, { roomId: "room_one", title: "Shared project", visibility: "shared", createdAt: 1 });
  await createCollaborationRoom(env, owner, { roomId: "room_two", title: "Private project", visibility: "private", createdAt: 1 });
  await addCollaborationMember(env, owner, "room_one", {
    userId: member.userId, actorId: humanActorId(member.userId), kind: "human", displayName: "Bob", createdAt: 2,
  });
  return { env, sqlite };
}

function ref(note: CollaborationMemoryNote) {
  return { id: note.id, version: note.version, sha256: note.sha256 };
}

const input = { id: "ctx_release", title: "Release policy", content: "Release on Tuesdays with a reviewed checklist." };
afterEach(() => vi.restoreAllMocks());

describe("explicit room-shared memory", () => {
  it("persists immutable provenance and lets only current room members recall selected notes", async () => {
    const { env } = await fixture();
    Object.defineProperty(env, "Memory", { get: () => { throw new Error("Private memory must not be queried."); } });
    const note = await createCollaborationMemory(env, owner, "room_one", input, 10);
    expect(note).toMatchObject({ ...input, version: 1, createdByUserId: owner.userId, createdAt: 10, revokedAt: null });
    expect(note.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await listCollaborationMemory({ ...env } as Env, member, "room_one")).toEqual([note]);
    expect(await snapshotCollaborationMemory(env, member, "room_one", [ref(note)])).toEqual([note]);
    expect(await listCollaborationMemory(env, owner, "room_two")).toEqual([]);
    await expect(listCollaborationMemory(env, { ...owner, userId: "outsider@example.test" }, "room_one")).rejects.toMatchObject({ status: 404 });
    await expect(listCollaborationMemory(env, { ...owner, tenantId: "other" }, "room_one")).rejects.toMatchObject({ status: 404 });
    await expect(listCollaborationMemory(env, { ...owner, workspaceId: "other" }, "room_one")).rejects.toMatchObject({ status: 404 });
    await expect(snapshotCollaborationMemory(env, owner, "room_two", [ref(note)])).rejects.toMatchObject({ status: 409 });
  });

  it("deduplicates identical submissions and never overwrites the approved source bytes", async () => {
    const { env } = await fixture();
    const note = await createCollaborationMemory(env, owner, "room_one", input, 10);
    expect(await createCollaborationMemory(env, owner, "room_one", input, 99)).toEqual(note);
    await expect(createCollaborationMemory(env, owner, "room_one", { ...input, content: "different" })).rejects.toMatchObject({ status: 409 });
    await expect(createCollaborationMemory(env, member, "room_one", input)).rejects.toMatchObject({ status: 409 });
    expect(await snapshotCollaborationMemory(env, member, "room_one", [ref(note)])).toEqual([note]);
  });

  it("allows only the author or current human room owner to revoke without reactivating old references", async () => {
    const { env } = await fixture();
    const note = await createCollaborationMemory(env, owner, "room_one", input);
    await expect(revokeCollaborationMemory(env, member, "room_one", ref(note))).rejects.toMatchObject({ status: 404 });
    expect(await revokeCollaborationMemory(env, owner, "room_one", ref(note), 20)).toBe(true);
    expect(await revokeCollaborationMemory(env, owner, "room_one", ref(note), 21)).toBe(true);
    expect(await listCollaborationMemory(env, member, "room_one")).toEqual([]);
    await expect(snapshotCollaborationMemory(env, member, "room_one", [ref(note)])).rejects.toMatchObject({ status: 409 });
    await expect(createCollaborationMemory(env, owner, "room_one", input)).rejects.toMatchObject({ status: 409 });
    const bobNote = await createCollaborationMemory(env, member, "room_one", { ...input, id: "ctx_bob" });
    expect(await revokeCollaborationMemory(env, owner, "room_one", ref(bobNote))).toBe(true);
  });

  it("honors removal, read-only capabilities and agent boundaries", async () => {
    const { env, sqlite } = await fixture();
    const note = await createCollaborationMemory(env, owner, "room_one", input);
    sqlite.prepare("UPDATE collaboration_memberships SET capabilities_json='[\"room.read\"]' WHERE user_id=?").run(member.userId);
    expect(await snapshotCollaborationMemory(env, member, "room_one", [ref(note)])).toEqual([note]);
    await expect(createCollaborationMemory(env, member, "room_one", { ...input, id: "ctx_readonly" })).rejects.toMatchObject({ status: 404 });
    await expect(revokeCollaborationMemory(env, member, "room_one", ref(note))).rejects.toMatchObject({ status: 404 });
    await removeCollaborationMember(env, owner, "room_one", humanActorId(member.userId), 30);
    await expect(snapshotCollaborationMemory(env, member, "room_one", [ref(note)])).rejects.toMatchObject({ status: 404 });
    await addCollaborationMember(env, owner, "room_one", { userId: "bot-user", actorId: "agent:planner", kind: "agent", profileVersion: 1, displayName: "Planner", createdAt: 31 });
    await expect(createCollaborationMemory(env, { ...owner, userId: "bot-user" }, "room_one", { ...input, id: "ctx_bot" })).rejects.toMatchObject({ status: 404 });
  });

  it("binds snapshots to exact bytes and scope rather than trusting a stored digest", async () => {
    const { env, sqlite } = await fixture();
    const note = await createCollaborationMemory(env, owner, "room_one", input);
    const sameIdElsewhere = await createCollaborationMemory(env, owner, "room_two", input);
    expect(sameIdElsewhere.sha256).not.toBe(note.sha256);
    await expect(snapshotCollaborationMemory(env, owner, "room_one", [{ ...ref(note), sha256: "0".repeat(64) }])).rejects.toMatchObject({ status: 409 });
    sqlite.prepare("UPDATE collaboration_memory SET content='changed after selection' WHERE room_id='room_one'").run();
    await expect(snapshotCollaborationMemory(env, owner, "room_one", [ref(note)])).rejects.toMatchObject({ status: 409 });
  });

  it("keeps retained Slack room context behind its current explicit audience policy", async () => {
    const { env, sqlite } = await fixture();
    env.SLACK_CANVAS_OWNERS = JSON.stringify([{ teamId: "T1", channelId: "C1", ownerId: owner.userId, viewerIds: [member.userId] }]);
    sqlite.prepare(`INSERT INTO collaboration_slack_room_links
      (link_id,tenant_id,workspace_id,room_id,owner_user_id,team_id,channel_id,thread_ts,status,created_at,revoked_at)
      VALUES ('link_one','self-hosted','default','room_one',?,'T1','C1','123.000001','active',1,NULL)`).run(owner.userId);
    const note = await createCollaborationMemory(env, owner, "room_one", input);
    expect(await snapshotCollaborationMemory(env, member, "room_one", [ref(note)])).toEqual([note]);
    env.SLACK_CANVAS_OWNERS = "[]";
    await expect(listCollaborationMemory(env, member, "room_one")).rejects.toMatchObject({ status: 404 });
    await expect(snapshotCollaborationMemory(env, owner, "room_one", [ref(note)])).rejects.toMatchObject({ status: 404 });
    sqlite.prepare("UPDATE collaboration_slack_room_links SET status='revoked',revoked_at=5").run();
    env.SLACK_CANVAS_OWNERS = JSON.stringify([{ teamId: "T1", channelId: "C1", ownerId: owner.userId }]);
    await expect(listCollaborationMemory(env, member, "room_one")).rejects.toMatchObject({ status: 404 });
  });

  it("rechecks membership after hashing and refuses a creation that lost its grant", async () => {
    const { env, sqlite } = await fixture();
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, bytes) => {
      const result = await digest(algorithm, bytes);
      sqlite.prepare("UPDATE collaboration_memberships SET status='removed' WHERE user_id=?").run(member.userId);
      return result;
    });
    await expect(createCollaborationMemory(env, member, "room_one", input)).rejects.toMatchObject({ status: 404 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM collaboration_memory").get()?.count).toBe(0);
  });

  it("rechecks note revocation after hashing before returning a snapshot", async () => {
    const { env, sqlite } = await fixture();
    const note = await createCollaborationMemory(env, owner, "room_one", input);
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, bytes) => {
      const result = await digest(algorithm, bytes);
      sqlite.prepare("UPDATE collaboration_memory SET revoked_at=20 WHERE context_id=?").run(note.id);
      return result;
    });
    await expect(snapshotCollaborationMemory(env, owner, "room_one", [ref(note)])).rejects.toMatchObject({ status: 409 });
  });

  it("enforces note, count and selected-context bounds without silently truncating", async () => {
    const { env } = await fixture();
    await expect(createCollaborationMemory(env, owner, "room_one", { ...input, content: "x".repeat(4_001) })).rejects.toMatchObject({ status: 400 });
    await expect(createCollaborationMemory(env, owner, "room_one", { ...input, id: "../escape" })).rejects.toMatchObject({ status: 400 });
    await expect(createCollaborationMemory(env, owner, "room_one", { ...input, title: " " })).rejects.toMatchObject({ status: 400 });
    const notes = [];
    for (let index = 0; index < COLLAB_MEMORY_MAX_NOTES; index++) {
      notes.push(await createCollaborationMemory(env, owner, "room_one", { ...input, id: `ctx_${index}`, content: "x".repeat(3_100) }));
    }
    await expect(createCollaborationMemory(env, owner, "room_one", { ...input, id: "ctx_overflow" })).rejects.toMatchObject({ status: 409 });
    await expect(snapshotCollaborationMemory(env, owner, "room_one", notes.slice(0, 9).map(ref))).rejects.toMatchObject({ status: 400 });
    await expect(snapshotCollaborationMemory(env, owner, "room_one", notes.slice(0, 2).map(ref))).rejects.toMatchObject({ status: 400 });
    await expect(snapshotCollaborationMemory(env, owner, "room_one", [ref(notes[0] as CollaborationMemoryNote), ref(notes[0] as CollaborationMemoryNote)])).rejects.toMatchObject({ status: 400 });
    await expect(snapshotCollaborationMemory(env, owner, "room_one", [{ ...ref(notes[0] as CollaborationMemoryNote), version: 2 }])).rejects.toMatchObject({ status: 400 });
    await expect(snapshotCollaborationMemory(env, owner, "room_one", [{ ...ref(notes[0] as CollaborationMemoryNote), sha256: {} } as never])).rejects.toMatchObject({ status: 400 });
  });

  it("redacts recognized credentials before hashing and sharing a note", async () => {
    const { env } = await fixture();
    const token = `ghp_${"a".repeat(36)}`;
    const note = await createCollaborationMemory(env, owner, "room_one", { ...input, content: `Do not reuse ${token}` });
    expect(note.content).not.toContain(token);
    expect(note.content).toContain("[redacted]");
    expect(await snapshotCollaborationMemory(env, member, "room_one", [ref(note)])).toEqual([note]);
  });
});
