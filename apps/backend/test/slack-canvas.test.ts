import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { handleSlackCanvas } from "../src/slack-canvas-routes.js";
import {
  buildSlackCanvasUrl, parseSlackCanvasOwners, parseSlackCanvasOrigin, resolveSlackCanvasBinding,
  signSlackCanvasIntake, signSlackCanvasRequest, verifySlackCanvasIntake, verifySlackCanvasRequest,
} from "../src/slack-canvas.js";

const KEY = "test-internal-signing-key-32-characters";
const ORIGIN = "slack:T1:C1:123.456";
const APPROVAL = "call_canvas_approval";
const OWNER = "owner@example.test";
const policy = JSON.stringify([{ teamId: "T1", channelId: "C1", ownerId: OWNER }]);

function env(): Env {
  return { REQUIRE_ACCESS: "1", INTERNAL_SIGNING_KEY: KEY, SLACK_CANVAS_OWNERS: policy, WORKER_HOSTNAME: "shiba.example.test" } as Env;
}

let frozenRoom: Awaited<ReturnType<typeof resolveSlackCanvasBinding>>;
beforeAll(async () => { frozenRoom = await resolveSlackCanvasBinding(env(), ORIGIN, APPROVAL); });

function request(origin = ORIGIN, owner = OWNER, socket = false): Request {
  const url = new URL(socket ? "https://shiba.example.test/api/slack-canvas/websocket" : "https://shiba.example.test/api/slack-canvas");
  url.searchParams.set("origin", origin);
  url.searchParams.set("approval", APPROVAL);
  if (socket) url.searchParams.set("viewer", "11111111-1111-4111-8111-111111111111");
  return new Request(url, { headers: {
    "CF-Access-Authenticated-User-Email": owner,
    ...(socket ? { Upgrade: "websocket", Origin: "https://shiba.example.test" } : {}),
  } });
}

function pending() {
  return {
    source: "slack", origin: ORIGIN,
    runRoom: frozenRoom,
    approval: { approvalId: APPROVAL, threadKey: ORIGIN, status: "pending", task: "Prepare a report", repoUrl: "", createdAt: Date.now(), executionTarget: { kind: "artifact-workspace", workspaceId: "report" } },
  };
}

async function running() {
  const binding = await resolveSlackCanvasBinding(env(), ORIGIN, APPROVAL);
  return {
    ...pending(), approval: { ...pending().approval, status: "approved" },
    run: { runId: binding?.runId, status: "running", approval: { approvalId: APPROVAL }, summary: "Working", envSealed: "must-not-be-exposed" },
    runRoom: binding,
  };
}

describe("Slack canvas owner policy and locators", () => {
  it("requires explicit exact team/channel policy and normalizes the configured owner", async () => {
    expect(parseSlackCanvasOwners(JSON.stringify([{ teamId: "T1", channelId: "C1", ownerId: " OWNER@EXAMPLE.TEST " }]))).toEqual([{ teamId: "T1", channelId: "C1", ownerId: OWNER }]);
    expect(parseSlackCanvasOrigin(ORIGIN)?.orchestratorName).toBe(ORIGIN);
    expect(parseSlackCanvasOrigin("slack-command:T1:C1")?.orchestratorName).toBe("default");
    const binding = await resolveSlackCanvasBinding(env(), ORIGIN, APPROVAL);
    expect(binding).toMatchObject({ ownerId: OWNER, runId: `agent-tool:${APPROVAL}` });
    expect(binding?.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await resolveSlackCanvasBinding(env(), ORIGIN, APPROVAL)).toEqual(binding);
    expect((await resolveSlackCanvasBinding(env(), ORIGIN, "other"))?.sessionId).not.toBe(binding?.sessionId);
    expect(await resolveSlackCanvasBinding(env(), "slack:T2:C1:123.456", APPROVAL)).toBeNull();
    expect(await resolveSlackCanvasBinding(env(), "slack:T1:C2:123.456", APPROVAL)).toBeNull();
  });

  it.each([
    undefined, "", "invalid", "{}", '[{"teamId":"T1","channelId":"C1","ownerId":"invalid"}]',
    '[{"teamId":"T1","channelId":"C1","ownerId":"owner@example.test","extra":true}]',
    JSON.stringify([{ teamId: "T1", channelId: "C1", ownerId: OWNER }, { teamId: "T1", channelId: "C1", ownerId: "other@example.test" }]),
    JSON.stringify(Array.from({ length: 65 }, (_, index) => ({ teamId: "T1", channelId: `C${index}`, ownerId: OWNER }))),
  ])("fails closed for invalid or ambiguous policy %s", (raw) => {
    expect(parseSlackCanvasOwners(raw)).toEqual([]);
    expect(buildSlackCanvasUrl({ ...env(), SLACK_CANVAS_OWNERS: raw }, { threadKey: ORIGIN, approvalId: APPROVAL })).toBeUndefined();
  });

  it("creates an exact HTTPS locator without an identity or bearer capability", () => {
    const url = new URL(buildSlackCanvasUrl(env(), { threadKey: ORIGIN, approvalId: APPROVAL }) ?? "");
    expect(url.pathname).toBe("/slack-canvas/");
    expect([...url.searchParams]).toEqual([["origin", ORIGIN], ["approval", APPROVAL]]);
    expect(buildSlackCanvasUrl({ ...env(), INTERNAL_SIGNING_KEY: "short" }, { threadKey: ORIGIN, approvalId: APPROVAL })).toBeUndefined();
    expect(buildSlackCanvasUrl({ ...env(), WORKER_HOSTNAME: "http://shiba.example.test" }, { threadKey: ORIGIN, approvalId: APPROVAL })).toBeUndefined();
    expect(buildSlackCanvasUrl(env(), { threadKey: "web:owner:123", approvalId: APPROVAL })).toBeUndefined();
  });

  it("accepts at most sixteen explicit viewer emails without changing the frozen owner room", async () => {
    const extended = JSON.stringify([{ teamId: "T1", channelId: "C1", ownerId: OWNER, viewerIds: [" BOB@EXAMPLE.TEST "] }]);
    expect(parseSlackCanvasOwners(extended)).toEqual([{ teamId: "T1", channelId: "C1", ownerId: OWNER, viewerIds: ["bob@example.test"] }]);
    expect(await resolveSlackCanvasBinding({ ...env(), SLACK_CANVAS_OWNERS: extended }, ORIGIN, APPROVAL)).toEqual(frozenRoom);
    for (const viewerIds of ["bob@example.test", ["invalid"], ["bob@example.test", " BOB@example.test "], Array.from({ length: 17 }, (_, index) => `viewer${index}@example.test`)]) {
      expect(parseSlackCanvasOwners(JSON.stringify([{ teamId: "T1", channelId: "C1", ownerId: OWNER, viewerIds }]))).toEqual([]);
    }
  });
});

describe("Slack canvas internal provenance", () => {
  it("binds body, target DO, method, path, query, origin and time", async () => {
    const original = new Request("https://internal/api/runs?command=one", { method: "POST", body: JSON.stringify({ task: "report", threadKey: ORIGIN }) });
    const signed = await signSlackCanvasIntake(original, KEY, ORIGIN, 1_000_000);
    expect(await verifySlackCanvasIntake(signed, KEY, ORIGIN, 1_000_000)).toBe(ORIGIN);
    expect(await verifySlackCanvasIntake(signed, KEY, "default", 1_000_000)).toBeNull();
    expect(await verifySlackCanvasIntake(signed, KEY, ORIGIN, 1_400_000)).toBeNull();
    expect(await verifySlackCanvasIntake(signed, "short", ORIGIN, 1_000_000)).toBeNull();
    for (const changed of [
      new Request(signed, { body: JSON.stringify({ task: "changed", threadKey: ORIGIN }) }),
      new Request("https://internal/api/runs?command=two", signed),
      new Request("https://internal/api/approvals", signed),
      new Request(signed, { headers: { ...Object.fromEntries(signed.headers), "X-Shiba-Slack-Canvas-Origin": "slack:T1:C1:124.456" } }),
    ]) expect(await verifySlackCanvasRequest(changed, KEY, ORIGIN, 1_000_000)).toBeNull();
    const read = await signSlackCanvasRequest(new Request(`https://internal/internal/slack-canvas?approval=${APPROVAL}`), KEY, ORIGIN, 1_000_000);
    expect(await verifySlackCanvasRequest(read, KEY, ORIGIN, 1_000_000)).toBe(ORIGIN);
    expect(await verifySlackCanvasIntake(read, KEY, ORIGIN, 1_000_000)).toBeNull();
  });
});

describe("Slack canvas dedicated read routes", () => {
  it("serves only exact retained pending approval fields through a signed internal read", async () => {
    const fetch = vi.fn(async (internal: Request) => {
      expect(await verifySlackCanvasRequest(internal, KEY, ORIGIN)).toBe(ORIGIN);
      return Response.json({ ...pending(), envSealed: "not-visible" });
    });
    const response = await handleSlackCanvas(request(), env(), { orchestrator: async (name) => { expect(name).toBe(ORIGIN); return { fetch }; } });
    expect(response?.status).toBe(200);
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
    expect(await response?.json()).toEqual({ state: "pending", approval: { approvalId: APPROVAL, status: "pending", task: "Prepare a report", workspaceLabel: "Workspace report" } });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("denies unauthenticated, cross-owner, unconfigured and revoked access before resolving any DO", async () => {
    const orchestrator = vi.fn();
    const unauthenticated = request();
    unauthenticated.headers.delete("CF-Access-Authenticated-User-Email");
    expect((await handleSlackCanvas(unauthenticated, env(), { orchestrator }))?.status).toBe(401);
    expect((await handleSlackCanvas(request(ORIGIN, "intruder@example.test"), env(), { orchestrator }))?.status).toBe(404);
    expect((await handleSlackCanvas(request(), { ...env(), SLACK_CANVAS_OWNERS: "[]" }, { orchestrator }))?.status).toBe(404);
    expect((await handleSlackCanvas(request(), { ...env(), INTERNAL_SIGNING_KEY: "" }, { orchestrator }))?.status).toBe(404);
    expect((await handleSlackCanvas(request(), { ...env(), REQUIRE_ACCESS: undefined }, { orchestrator }))?.status).toBe(401);
    expect(orchestrator).not.toHaveBeenCalled();
  });

  it.each(["origin", "approval", "kind", "expired", "missing-proof"])("refuses a pending record with invalid %s", async (kind) => {
    const snapshot = pending() as ReturnType<typeof pending> & { source?: string };
    if (kind === "origin") snapshot.origin = "slack:T1:C1:999.999";
    if (kind === "approval") snapshot.approval.approvalId = "other";
    if (kind === "kind") Object.assign(snapshot.approval, { kind: "pr_publish" });
    if (kind === "expired") snapshot.approval.createdAt = 0;
    if (kind === "missing-proof") snapshot.source = "body-source-is-not-proof";
    const response = await handleSlackCanvas(request(), env(), { orchestrator: async () => ({ fetch: async () => Response.json(snapshot) }) });
    expect(response?.status).toBe(404);
  });

  it.each(["pending", "run"] as const)("denies a %s view after an owner policy change or without its frozen room", async (state) => {
    const changed = { ...env(), SLACK_CANVAS_OWNERS: JSON.stringify([{ teamId: "T1", channelId: "C1", ownerId: "new@example.test" }]) };
    const retained = state === "run" ? await running() : pending();
    const changedOwner = await handleSlackCanvas(request(ORIGIN, "new@example.test"), changed, {
      orchestrator: async () => ({ fetch: async () => Response.json(retained) }),
    });
    expect(changedOwner?.status).toBe(404);
    const withoutRoom = await handleSlackCanvas(request(), env(), {
      orchestrator: async () => ({ fetch: async () => Response.json({ ...retained, runRoom: undefined }) }),
    });
    expect(withoutRoom?.status).toBe(404);
  });

  it("projects a matching run and never returns private execution fields", async () => {
    const snapshot = await running();
    const response = await handleSlackCanvas(request(), env(), { orchestrator: async () => ({ fetch: async () => Response.json(snapshot) }) });
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      state: "run", run: { runId: `agent-tool:${APPROVAL}`, status: "running", task: "Prepare a report", workspaceLabel: "Workspace report", summary: "Working" },
      room: { sessionId: snapshot.runRoom?.sessionId, runId: `agent-tool:${APPROVAL}` },
    });
  });

  it.each([true, false])("exposes the frozen publication request for completed runs: %s", async (publishPullRequest) => {
    const snapshot = await running();
    const response = await handleSlackCanvas(request(), env(), { orchestrator: async () => ({
      fetch: async () => Response.json({ ...snapshot, run: { ...snapshot.run, status: "completed", publishPullRequest } }),
    }) });
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      state: "run", run: { runId: `agent-tool:${APPROVAL}`, status: "completed", task: "Prepare a report", workspaceLabel: "Workspace report", summary: "Working", publishPullRequest },
      room: { sessionId: snapshot.runRoom?.sessionId, runId: `agent-tool:${APPROVAL}` },
    });
  });

  it.each(["owner", "session", "run", "approval", "unapproved"])("refuses a run with mismatched frozen %s", async (kind) => {
    const snapshot = await running();
    if (kind === "owner") Object.assign(snapshot.runRoom ?? {}, { ownerId: "other@example.test" });
    if (kind === "session") Object.assign(snapshot.runRoom ?? {}, { sessionId: "default" });
    if (kind === "run") snapshot.run.runId = "other-run";
    if (kind === "approval") snapshot.run.approval.approvalId = "other";
    if (kind === "unapproved") snapshot.approval.status = "pending";
    expect((await handleSlackCanvas(request(), env(), { orchestrator: async () => ({ fetch: async () => Response.json(snapshot) }) }))?.status).toBe(404);
  });

  it("binds the read-only socket to exact server-owned room and run and rechecks policy on reconnect", async () => {
    const snapshot = await running();
    const roomFetch = vi.fn(async (forwarded: Request) => {
      expect(forwarded.headers.get("x-shiba-room-owner")).toBe(OWNER);
      expect(forwarded.headers.get("x-shiba-room-session")).toBe(snapshot.runRoom?.sessionId);
      expect(forwarded.headers.get("x-shiba-room-readonly")).toBe("true");
      expect(forwarded.headers.get("x-shiba-room-run")).toBe(`agent-tool:${APPROVAL}`);
      expect(forwarded.headers.get("x-shiba-room-actor")).toBe(OWNER);
      return new Response("upgrade stub");
    });
    const configured = { ...env(), ConversationRoom: { getByName: () => ({ fetch: roomFetch }) } } as unknown as Env;
    const socket = request(ORIGIN, OWNER, true);
    socket.headers.set("x-shiba-room-owner", "forged@example.test");
    socket.headers.set("x-shiba-room-actor", "forged@example.test");
    const deps = { orchestrator: async () => ({ fetch: async () => Response.json(snapshot) }) };
    expect((await handleSlackCanvas(socket, configured, deps))?.status).toBe(200);
    expect((await handleSlackCanvas(request(ORIGIN, OWNER, true), { ...configured, SLACK_CANVAS_OWNERS: "[]" }, deps))?.status).toBe(404);
    expect(roomFetch).toHaveBeenCalledOnce();
    const crossOrigin = request(ORIGIN, OWNER, true);
    crossOrigin.headers.set("Origin", "https://attacker.example.test");
    expect((await handleSlackCanvas(crossOrigin, configured, deps))?.status).toBe(403);
    expect(roomFetch).toHaveBeenCalledOnce();
  });

  it("grants listed viewers only the exact read-only canvas and revokes their reconnects", async () => {
    const viewer = "bob@example.test";
    const configured = { ...env(), SLACK_CANVAS_OWNERS: JSON.stringify([{ teamId: "T1", channelId: "C1", ownerId: OWNER, viewerIds: [viewer] }]) };
    const snapshot = await running();
    const orchestrator = vi.fn(async () => ({ fetch: async () => Response.json(snapshot) }));
    const roomFetch = vi.fn(async (forwarded: Request) => {
      expect(forwarded.headers.get("x-shiba-room-owner")).toBe(OWNER);
      expect(forwarded.headers.get("x-shiba-room-actor")).toBe(viewer);
      expect(forwarded.headers.get("x-shiba-room-readonly")).toBe("true");
      expect(forwarded.headers.get("x-shiba-room-viewer")).not.toBe("11111111-1111-4111-8111-111111111111");
      return new Response("upgrade stub");
    });
    const withRoom = { ...configured, ConversationRoom: { getByName: () => ({ fetch: roomFetch }) } } as unknown as Env;
    expect((await handleSlackCanvas(request(ORIGIN, viewer), configured, { orchestrator }))?.status).toBe(200);
    const socket = request(ORIGIN, viewer, true);
    socket.headers.set("x-shiba-room-actor", OWNER);
    socket.headers.set("x-shiba-room-owner", viewer);
    expect((await handleSlackCanvas(socket, withRoom, { orchestrator }))?.status).toBe(200);
    expect((await handleSlackCanvas(request(ORIGIN, viewer, true), { ...withRoom, SLACK_CANVAS_OWNERS: policy }, { orchestrator }))?.status).toBe(404);
    expect((await handleSlackCanvas(request("slack:T1:C2:123.456", viewer), withRoom, { orchestrator }))?.status).toBe(404);
    expect((await handleSlackCanvas(request(ORIGIN, "unknown@example.test"), withRoom, { orchestrator }))?.status).toBe(404);
    expect(orchestrator).toHaveBeenCalledTimes(2);
    expect(roomFetch).toHaveBeenCalledOnce();
    expect((await handleSlackCanvas(new Request(request(ORIGIN, viewer), { method: "POST", body: "{}" }), withRoom, { orchestrator }))?.status).toBe(405);
  });

  it("refuses sockets for a pending approval and all mutation methods", async () => {
    const deps = { orchestrator: async () => ({ fetch: async () => Response.json(pending()) }) };
    expect((await handleSlackCanvas(request(ORIGIN, OWNER, true), env(), deps))?.status).toBe(409);
    expect((await handleSlackCanvas(new Request(request(), { method: "POST", body: "{}" }), env(), deps))?.status).toBe(405);
  });
});
