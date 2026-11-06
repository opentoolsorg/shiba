import { describe, expect, it } from "vitest";
import {
  bindCollaborationContextApproval, freezeCollaborationContext,
  isCollaborationApprovalDispatchable, isCollaborationContextCurrent,
} from "../src/collaboration-context.js";
import { createCollaborationMemory, revokeCollaborationMemory } from "../src/collaboration-memory.js";
import {
  addCollaborationMember, cancelCollaborationHandoff, createCollaborationAgentReply,
  createCollaborationMessage, createCollaborationRoom, createRootCollaborationHandoff,
  humanActorId, linkCollaborationHandoffRun, removeCollaborationMember,
  type CollaborationHandoffRow, type CollaborationScope,
} from "../src/collaboration-store.js";
import type { Env } from "../src/env.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

const OWNER = "owner@example.test";
const MEMBER = "member@example.test";
const ROOM = `room_${"c".repeat(24)}`;
const PRIVATE_ROOM = `room_${"d".repeat(24)}`;
const HANDOFF = "handoff-context";
const APPROVAL = "approval-context";
const TASK = "Prepare the shared report.";
const owner: CollaborationScope = { tenantId: "self-hosted", workspaceId: "default", userId: OWNER };
const member: CollaborationScope = { ...owner, userId: MEMBER };

async function fixture() {
  const { database, sqlite } = customAgentD1();
  const env = { AGENT_AUDIT: database } as unknown as Env;
  Object.defineProperty(env, "Memory", { get() { throw new Error("Private owner memory must not be queried."); } });
  await createCollaborationRoom(env, owner, { roomId: ROOM, title: "Shared report", visibility: "shared", createdAt: 1 });
  await createCollaborationRoom(env, owner, { roomId: PRIVATE_ROOM, title: "Other private room", visibility: "private", createdAt: 1 });
  await addCollaborationMember(env, owner, ROOM, { userId: MEMBER, actorId: humanActorId(MEMBER), kind: "human", displayName: "Member", createdAt: 2 });
  await addCollaborationMember(env, owner, ROOM, { userId: OWNER, actorId: "agent:writer", kind: "agent", profileVersion: 1, displayName: "Writer", createdAt: 2 });
  const handoff = async (id = HANDOFF, sender = owner) => {
    const input: CollaborationHandoffRow = {
      ...owner, handoffId: id, roomId: ROOM, taskId: `task-${id}`,
      senderUserId: sender.userId, senderActorId: humanActorId(sender.userId),
      recipientUserId: OWNER, recipientActorId: "agent:writer", parentHandoffId: null,
      rootHandoffId: id, depth: 0, ancestorHandoffIds: [], remainingBudget: 0,
      grantedCapabilities: ["room.read"], profileVersion: 1, status: "active", createdAt: 3, cancelledAt: null,
    };
    expect(await createRootCollaborationHandoff(env, sender, input)).not.toBeNull();
  };
  const message = async (id: string, body: string, sender = owner, roomId = ROOM, createdAt = 4) => {
    expect(await createCollaborationMessage(env, sender, {
      ...sender, messageId: id, roomId, senderUserId: sender.userId,
      senderActorId: humanActorId(sender.userId), senderKind: "human", body, profileVersion: null, createdAt,
    })).not.toBeNull();
  };
  const note = (id = "ctx_release", content = "Release is Tuesday.", roomId = ROOM) => createCollaborationMemory(
    env, owner, roomId, { id, title: "Release fact", content }, 5,
  );
  const dispatch = (task: string, id = HANDOFF, approvalId = APPROVAL) => isCollaborationApprovalDispatchable(env, {
    handoffId: id, approvalId, employeeId: "writer", employeeVersion: 1, task,
  });
  const link = (id = HANDOFF, approvalId = APPROVAL) => linkCollaborationHandoffRun(env, owner, id, approvalId, `agent-tool:${approvalId}`);
  await handoff();
  return { env, sqlite, handoff, message, note, dispatch, link };
}

function ref(note: Awaited<ReturnType<typeof createCollaborationMemory>>) {
  return { id: note.id, version: note.version, sha256: note.sha256 };
}

async function hash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("explicit approval-bound shared room context", () => {
  it("freezes only selected room data with exact authors and hashes, without private memory or history", async () => {
    const f = await fixture();
    await f.message("msg_selected", "Selected teammate fact", member);
    await f.message("msg_unselected", "Unselected shared conversation");
    await f.message("msg_private", "Private room history", owner, PRIVATE_ROOM);
    const note = await f.note();
    const frozen = await freezeCollaborationContext(f.env, owner, ROOM, HANDOFF, TASK, ["msg_selected"], [ref(note)]);
    expect(frozen.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(frozen.task).toContain("Selected teammate fact");
    expect(frozen.task).toContain(`human:${MEMBER}`);
    expect(frozen.task).toContain(note.content);
    expect(frozen.task).not.toContain("Unselected shared conversation");
    expect(frozen.task).not.toContain("Private room history");
    const row = f.sqlite.prepare("SELECT snapshot_json FROM collaboration_context_snapshots WHERE handoff_id=?").get(HANDOFF);
    const saved = JSON.parse(String(row?.snapshot_json));
    expect(saved.messageRefs).toEqual([{ id: "msg_selected", sha256: await hash({
      id: "msg_selected", author: humanActorId(MEMBER), createdAt: 4, body: "Selected teammate fact",
    }) }]);
    expect(saved.memoryRefs).toEqual([ref(note)]);
    expect(saved.userId).toBe(OWNER);
    expect(saved.roomId).toBe(ROOM);
  });

  it("keeps no-selection handoffs free of implicit context while the full authority gate still applies", async () => {
    const f = await fixture();
    await f.message("msg_unselected", "Never automatically included");
    await f.note();
    expect(await freezeCollaborationContext(f.env, owner, ROOM, HANDOFF, TASK, [], [])).toEqual({ task: TASK });
    expect(f.sqlite.prepare("SELECT COUNT(*) AS count FROM collaboration_context_snapshots").get()?.count).toBe(0);
    expect(await isCollaborationContextCurrent(f.env, HANDOFF, TASK, APPROVAL)).toBe(false);
    expect(await f.dispatch(TASK)).toBe(false);
    expect(await f.link()).toBe(true);
    expect(await f.dispatch(TASK)).toBe(true);
    await cancelCollaborationHandoff(f.env, owner, HANDOFF, 10);
    expect(await f.dispatch(TASK)).toBe(false);
  });

  it("binds the full trusted effective task once, including profile prefix and required-output suffix", async () => {
    const f = await fixture();
    const note = await f.note();
    const frozen = await freezeCollaborationContext(f.env, owner, ROOM, HANDOFF, TASK, [], [ref(note)]);
    const effective = `Pinned employee instructions\n\n---\n\n${frozen.task}\n\nEphemeral workspace required outputs:\n- out/report.md`;
    await bindCollaborationContextApproval(f.env, HANDOFF, APPROVAL, effective);
    expect(await f.link()).toBe(true);
    expect(await f.dispatch(effective)).toBe(true);
    expect(await isCollaborationContextCurrent(f.env, HANDOFF, `${effective}\nchanged`, APPROVAL)).toBe(false);
    expect(await isCollaborationContextCurrent(f.env, HANDOFF, effective, "other-approval")).toBe(false);
    await expect(bindCollaborationContextApproval(f.env, HANDOFF, APPROVAL, `${frozen.task}\n${frozen.task}`)).rejects.toMatchObject({ status: 409 });
    await expect(bindCollaborationContextApproval(f.env, HANDOFF, "other-approval", effective)).rejects.toMatchObject({ status: 409 });
  });

  it("recovers both bind/link crash boundaries without admitting an orphan approval or changing the frozen snapshot", async () => {
    const f = await fixture();
    const note = await f.note();
    const selected = [ref(note)];
    const frozen = await freezeCollaborationContext(f.env, owner, ROOM, HANDOFF, TASK, [], selected);
    // Minted approval response is lost before binding: there is no dispatchable handoff.
    expect(await f.dispatch(frozen.task)).toBe(false);
    expect(await freezeCollaborationContext(f.env, owner, ROOM, HANDOFF, TASK, [], selected)).toEqual(frozen);
    await bindCollaborationContextApproval(f.env, HANDOFF, APPROVAL, frozen.task);
    // Parent crashes after binding but before linking: retry can bind identically.
    expect(await f.dispatch(frozen.task)).toBe(false);
    await bindCollaborationContextApproval(f.env, HANDOFF, APPROVAL, frozen.task);
    expect(await f.link()).toBe(true);
    expect(await f.link()).toBe(true);
    expect(await f.dispatch(frozen.task)).toBe(true);
    expect(f.sqlite.prepare("SELECT COUNT(*) AS count FROM collaboration_context_snapshots").get()?.count).toBe(1);
    expect(f.sqlite.prepare("SELECT approval_id,run_id FROM collaboration_handoffs WHERE handoff_id=?").get(HANDOFF))
      .toEqual({ approval_id: APPROVAL, run_id: `agent-tool:${APPROVAL}` });
  });

  it("rejects changed retry instructions, selections and selected source bytes", async () => {
    const f = await fixture();
    await f.message("msg_one", "Original shared fact");
    await f.message("msg_two", "Another fact");
    const note = await f.note();
    await freezeCollaborationContext(f.env, owner, ROOM, HANDOFF, TASK, ["msg_one"], [ref(note)]);
    for (const [task, ids, notes] of [
      ["Changed task", ["msg_one"], [ref(note)]], [TASK, ["msg_two"], [ref(note)]], [TASK, ["msg_one"], []],
    ] as const) {
      await expect(freezeCollaborationContext(f.env, owner, ROOM, HANDOFF, task, ids, notes)).rejects.toMatchObject({ status: 409 });
    }
    f.sqlite.prepare("UPDATE collaboration_messages SET body='post-freeze mutation' WHERE message_id='msg_one'").run();
    await expect(freezeCollaborationContext(f.env, owner, ROOM, HANDOFF, TASK, ["msg_one"], [ref(note)])).rejects.toMatchObject({ status: 409 });
  });

  it("rejects malformed, duplicate, foreign-room and forged version/hash selections", async () => {
    const f = await fixture();
    await f.message("msg_here", "Here");
    await f.message("msg_foreign", "Foreign", owner, PRIVATE_ROOM);
    const note = await f.note();
    const other = await f.note("ctx_other", "Other room source", PRIVATE_ROOM);
    for (const ids of [["msg_here", "msg_here"], ["../escape"], new Array(13).fill(0).map((_, index) => `msg_${index}`)]) {
      await expect(freezeCollaborationContext(f.env, owner, ROOM, HANDOFF, TASK, ids, [])).rejects.toMatchObject({ status: 400 });
    }
    for (const refs of [[ref(note), ref(note)], [{ ...ref(note), version: 2 }], [{ ...ref(note), sha256: "bad" }]]) {
      await expect(freezeCollaborationContext(f.env, owner, ROOM, HANDOFF, TASK, [], refs)).rejects.toMatchObject({ status: 400 });
    }
    for (const [ids, refs] of [[ ["msg_foreign"], [] ], [ ["msg_missing"], [] ], [ [], [ref(other)] ],
      [ [], [{ ...ref(note), sha256: "0".repeat(64) }] ], [ [], [{ id: "ctx_missing", version: 1, sha256: "0".repeat(64) }] ]] as const) {
      await expect(freezeCollaborationContext(f.env, owner, ROOM, HANDOFF, TASK, ids, refs)).rejects.toMatchObject({ status: 409 });
    }
    await revokeCollaborationMemory(f.env, owner, ROOM, ref(note), 10);
    await expect(freezeCollaborationContext(f.env, owner, ROOM, HANDOFF, TASK, [], [ref(note)])).rejects.toMatchObject({ status: 409 });
  });

  it("bounds the complete selected-context task at 4000 characters before any snapshot is persisted", async () => {
    const f = await fixture();
    await f.message("msg_large", "x".repeat(3_900));
    await expect(freezeCollaborationContext(f.env, owner, ROOM, HANDOFF, TASK, ["msg_large"], [])).rejects.toMatchObject({ status: 400 });
    expect(f.sqlite.prepare("SELECT COUNT(*) AS count FROM collaboration_context_snapshots").get()?.count).toBe(0);
  });

  it("fences revoked or mutated shared notes and removed requesting members after binding", async () => {
    for (const revoke of [true, false]) {
      const f = await fixture();
      const note = await f.note();
      const frozen = await freezeCollaborationContext(f.env, owner, ROOM, HANDOFF, TASK, [], [ref(note)]);
      await bindCollaborationContextApproval(f.env, HANDOFF, APPROVAL, frozen.task);
      await f.link();
      expect(await f.dispatch(frozen.task)).toBe(true);
      if (revoke) await revokeCollaborationMemory(f.env, owner, ROOM, ref(note), 10);
      else f.sqlite.prepare("UPDATE collaboration_memory SET content='mutated bytes' WHERE context_id=?").run(note.id);
      expect(await f.dispatch(frozen.task)).toBe(false);
    }
    const f = await fixture();
    await f.handoff("handoff-member", member);
    const note = await f.note();
    const frozen = await freezeCollaborationContext(f.env, member, ROOM, "handoff-member", TASK, [], [ref(note)]);
    await bindCollaborationContextApproval(f.env, "handoff-member", "approval-member", frozen.task);
    expect(await linkCollaborationHandoffRun(f.env, member, "handoff-member", "approval-member", "agent-tool:approval-member")).toBe(true);
    expect(await f.dispatch(frozen.task, "handoff-member", "approval-member")).toBe(true);
    await removeCollaborationMember(f.env, owner, ROOM, humanActorId(MEMBER), 10);
    expect(await isCollaborationContextCurrent(f.env, "handoff-member", frozen.task, "approval-member")).toBe(false);
  });

  it("rechecks retained Slack source grants for both selected and legacy handoffs", async () => {
    const f = await fixture();
    f.env.SLACK_CANVAS_OWNERS = JSON.stringify([{ teamId: "T1", channelId: "C1", ownerId: OWNER, viewerIds: [MEMBER] }]);
    f.sqlite.prepare(`INSERT INTO collaboration_slack_room_links
      (link_id,tenant_id,workspace_id,room_id,owner_user_id,team_id,channel_id,thread_ts,status,created_at,revoked_at)
      VALUES ('link_context','self-hosted','default',?,?,'T1','C1','123.000001','revoked',1,2)`).run(ROOM, OWNER);
    const note = await f.note();
    const frozen = await freezeCollaborationContext(f.env, owner, ROOM, HANDOFF, TASK, [], [ref(note)]);
    await bindCollaborationContextApproval(f.env, HANDOFF, APPROVAL, frozen.task);
    await f.link();
    await f.handoff("handoff-legacy");
    await f.link("handoff-legacy", "approval-legacy");
    expect(await f.dispatch(frozen.task)).toBe(true);
    expect(await f.dispatch(TASK, "handoff-legacy", "approval-legacy")).toBe(true);
    f.env.SLACK_CANVAS_OWNERS = "[]";
    expect(await f.dispatch(frozen.task)).toBe(false);
    expect(await f.dispatch(TASK, "handoff-legacy", "approval-legacy")).toBe(false);
  });

  it("keeps exact selected message references valid beyond the display's latest 200 messages", async () => {
    const f = await fixture();
    await f.message("msg_selected_old", "Durable approved fact");
    const frozen = await freezeCollaborationContext(f.env, owner, ROOM, HANDOFF, TASK, ["msg_selected_old"], []);
    await bindCollaborationContextApproval(f.env, HANDOFF, APPROVAL, frozen.task);
    await f.link();
    for (let index = 0; index < 205; index++) await f.message(`msg_new_${index}`, `Newer message ${index}`, owner, ROOM, 100 + index);
    expect(await f.dispatch(frozen.task)).toBe(true);
    expect(await freezeCollaborationContext(f.env, owner, ROOM, HANDOFF, TASK, ["msg_selected_old"], [])).toEqual(frozen);
  });

  it("invalidates a selected generated reply when its own approved source is revoked", async () => {
    const f = await fixture();
    const note = await f.note();
    const first = await freezeCollaborationContext(f.env, owner, ROOM, HANDOFF, TASK, [], [ref(note)]);
    await bindCollaborationContextApproval(f.env, HANDOFF, APPROVAL, first.task);
    await f.link();
    expect(await createCollaborationAgentReply(f.env, owner, {
      messageId: "agent_reply_source", roomId: ROOM, handoffId: HANDOFF, runId: `agent-tool:${APPROVAL}`,
      agentUserId: OWNER, agentActorId: "agent:writer", profileVersion: 1,
      body: "The report derived from the selected source.", sourceArtifactRefs: [], createdAt: 6,
    })).not.toBeNull();
    await f.handoff("handoff-derived");
    const second = await freezeCollaborationContext(f.env, owner, ROOM, "handoff-derived", TASK, ["agent_reply_source"], []);
    await bindCollaborationContextApproval(f.env, "handoff-derived", "approval-derived", second.task);
    await f.link("handoff-derived", "approval-derived");
    expect(await f.dispatch(second.task, "handoff-derived", "approval-derived")).toBe(true);
    await revokeCollaborationMemory(f.env, owner, ROOM, ref(note), 10);
    expect(await f.dispatch(second.task, "handoff-derived", "approval-derived")).toBe(false);
    await f.handoff("handoff-stale-reply");
    await expect(freezeCollaborationContext(f.env, owner, ROOM, "handoff-stale-reply", TASK, ["agent_reply_source"], [])).rejects.toMatchObject({ status: 409 });
  });

  it("bounds validation across sibling branches rather than giving each source a fresh budget", async () => {
    const f = await fixture();
    const note = await f.note();
    const first = await freezeCollaborationContext(f.env, owner, ROOM, HANDOFF, TASK, [], [ref(note)]);
    await bindCollaborationContextApproval(f.env, HANDOFF, APPROVAL, first.task);
    await f.link();
    const reply = async (id: string, handoffId: string, approvalId: string, createdAt: number) => {
      expect(await createCollaborationAgentReply(f.env, owner, {
        messageId: id, roomId: ROOM, handoffId, runId: `agent-tool:${approvalId}`,
        agentUserId: OWNER, agentActorId: "agent:writer", profileVersion: 1,
        body: `Derived fact ${id}`, sourceArtifactRefs: [], createdAt,
      })).not.toBeNull();
    };
    await reply("agent_reply_base", HANDOFF, APPROVAL, 10);
    let upstream = ["agent_reply_base"];
    for (let level = 1; level <= 2; level++) {
      const next: string[] = [];
      for (let branch = 0; branch < 3; branch++) {
        const id = `handoff_branch_${level}_${branch}`;
        const approvalId = `approval_branch_${level}_${branch}`;
        await f.handoff(id);
        const frozen = await freezeCollaborationContext(f.env, owner, ROOM, id, TASK, upstream, []);
        await bindCollaborationContextApproval(f.env, id, approvalId, frozen.task);
        await f.link(id, approvalId);
        const messageId = `agent_reply_branch_${level}_${branch}`;
        await reply(messageId, id, approvalId, 10 + level);
        next.push(messageId);
      }
      upstream = next;
    }
    await f.handoff("handoff_branch_final");
    // All four path levels fit, but the repeated DAG expansion visits
    // 1 + 3 + 9 + 9 snapshots and must exhaust the shared work budget.
    await expect(freezeCollaborationContext(f.env, owner, ROOM, "handoff_branch_final", TASK, upstream, [])).rejects.toMatchObject({ status: 409 });
  });

  it("fails closed on a cyclic stored provenance graph", async () => {
    const f = await fixture();
    const note = await f.note();
    const first = await freezeCollaborationContext(f.env, owner, ROOM, HANDOFF, TASK, [], [ref(note)]);
    await bindCollaborationContextApproval(f.env, HANDOFF, APPROVAL, first.task);
    await f.link();
    await createCollaborationAgentReply(f.env, owner, {
      messageId: "agent_reply_cycle_a", roomId: ROOM, handoffId: HANDOFF, runId: `agent-tool:${APPROVAL}`,
      agentUserId: OWNER, agentActorId: "agent:writer", profileVersion: 1,
      body: "Derived A", sourceArtifactRefs: [], createdAt: 10,
    });
    await f.handoff("handoff-cycle-b");
    const second = await freezeCollaborationContext(f.env, owner, ROOM, "handoff-cycle-b", TASK, ["agent_reply_cycle_a"], []);
    await bindCollaborationContextApproval(f.env, "handoff-cycle-b", "approval-cycle-b", second.task);
    await f.link("handoff-cycle-b", "approval-cycle-b");
    await createCollaborationAgentReply(f.env, owner, {
      messageId: "agent_reply_cycle_b", roomId: ROOM, handoffId: "handoff-cycle-b", runId: "agent-tool:approval-cycle-b",
      agentUserId: OWNER, agentActorId: "agent:writer", profileVersion: 1,
      body: "Derived B", sourceArtifactRefs: [], createdAt: 11,
    });
    // No API mutates a snapshot. Model a corrupt historical graph directly;
    // validation must terminate instead of recursively following it forever.
    const saved = JSON.parse(String(f.sqlite.prepare("SELECT snapshot_json FROM collaboration_context_snapshots WHERE handoff_id=?").get(HANDOFF)?.snapshot_json));
    saved.messageRefs.push({ id: "agent_reply_cycle_b", sha256: await hash({
      id: "agent_reply_cycle_b", author: "agent:writer", createdAt: 11, body: "Derived B",
      sourceHandoffId: "handoff-cycle-b", sourceRunId: "agent-tool:approval-cycle-b", sourceArtifactRefs: [],
    }) });
    f.sqlite.prepare("UPDATE collaboration_context_snapshots SET snapshot_json=? WHERE handoff_id=?").run(JSON.stringify(saved), HANDOFF);
    expect(await isCollaborationContextCurrent(f.env, HANDOFF, first.task, APPROVAL)).toBe(false);
    expect(await isCollaborationContextCurrent(f.env, "handoff-cycle-b", second.task, "approval-cycle-b")).toBe(false);
  });
});
