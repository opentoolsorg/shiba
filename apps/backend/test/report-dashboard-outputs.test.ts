import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deliverableByteLimit, deliverableMediaType, hasPdfMagic, isSafeDeliverablePath,
  MAX_PDF_DELIVERABLE_BYTES,
} from "@shiba/shared";
import { deliverableResponse, HTML_DELIVERABLE_CSP } from "../src/deliverable-response.js";
import { handleCollaborationWithRealtime } from "../src/collaboration-room-routes.js";
import { handleCollaborationShare } from "../src/collaboration-share-routes.js";
import { persistRunDeliverables, verifyExpectedDeliverables } from "../src/run-deliverables.js";
import type { Env } from "../src/env.js";

const state = vi.hoisted(() => ({
  scope: null as null | { tenantId: string; workspaceId: string; userId: string },
  canRead: true,
  run: null as unknown,
  denied: null as Response | null,
  messages: [] as unknown[],
}));
vi.mock("../src/request-auth.js", () => ({ isAuthorizedRequest: async (r: Request) => r.headers.get("Authorization") === "Bearer ok" }));
vi.mock("../src/team-collaboration-scope.js", () => ({ resolveTeamCollaborationScope: async () => state.scope }));
vi.mock("../src/collaboration-room-access.js", () => ({ canReadCollaborationRoom: async () => state.canRead, collaborationRoomName: () => "test-room" }));
vi.mock("../src/artifact-access.js", () => ({ assertSandboxArtifactAccess: async () => state.denied }));
vi.mock("../src/edge-identity.js", () => ({ signInternalRequest: async () => {} }));
vi.mock("agents/routing", () => ({
  getAgentByName: async () => ({ fetch: async () => (state.run ? Response.json({ run: state.run }) : Response.json({}, { status: 404 })) }),
}));
vi.mock("../src/collaboration-store.js", () => ({
  humanActorId: (id: string) => `human:${id}`,
  createCollaborationMessage: async (_e: unknown, _s: unknown, input: unknown) => { state.messages.push(input); return input; },
}));

const b64 = (text: string) => Buffer.from(text, "latin1").toString("base64");
const PDF = "%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n";
const file = (path: string, content: string | null, encoding: "utf8" | "base64" = "utf8") => ({ path, content, encoding });

describe("deliverable media types", () => {
  it("maps every allowed extension from one shared table", () => {
    expect(deliverableMediaType("a/dashboard.html")).toBe("text/html; charset=utf-8");
    expect(deliverableMediaType("report.PDF")).toBe("application/pdf");
    expect(deliverableMediaType("data.csv")).toBe("text/csv; charset=utf-8");
    expect(deliverableMediaType("x.exe")).toBeUndefined();
    expect(isSafeDeliverablePath("out/dashboard.html")).toBe(true);
    expect(isSafeDeliverablePath("report.pdf")).toBe(true);
    expect(deliverableByteLimit("report.pdf")).toBe(MAX_PDF_DELIVERABLE_BYTES);
    expect(deliverableByteLimit("a.md")).toBe(16_384);
  });

  it("accepts a PDF with valid magic bytes and stores raw bytes", async () => {
    const [artifact] = await verifyExpectedDeliverables(["report.pdf"], [file("report.pdf", b64(PDF), "base64")]);
    expect(artifact).toMatchObject({ mediaType: "application/pdf", bytes: PDF.length, encoding: "base64",
      sha256: createHash("sha256").update(Buffer.from(PDF, "latin1")).digest("hex") });
    const put = vi.fn(async () => ({}));
    const [meta] = await persistRunDeliverables({ ATTACHMENTS: { put } as unknown as R2Bucket } satisfies Pick<Env, "ATTACHMENTS">, "sb", [artifact!]);
    expect(meta).not.toHaveProperty("content");
    const stored = (put.mock.calls[0] as unknown[])[1] as Uint8Array;
    expect(Buffer.from(stored).toString("latin1")).toBe(PDF);
  });

  it("accepts a full-sized PDF without overflowing the base64 validator", async () => {
    const content = Buffer.alloc(MAX_PDF_DELIVERABLE_BYTES, 32);
    content.write("%PDF-1.7");
    const [artifact] = await verifyExpectedDeliverables(["report.pdf"], [file("report.pdf", content.toString("base64"), "base64")]);
    expect(artifact?.bytes).toBe(MAX_PDF_DELIVERABLE_BYTES);
  });

  it("rejects a fake PDF with a plain message", async () => {
    await expect(verifyExpectedDeliverables(["report.pdf"], [file("report.pdf", "just some text")]))
      .rejects.toThrow("Deliverable report.pdf is not a valid PDF file.");
    await expect(verifyExpectedDeliverables(["report.pdf"], [file("report.pdf", b64("just some text"), "base64")]))
      .rejects.toThrow("is not a valid PDF file");
    expect(hasPdfMagic(new TextEncoder().encode("%PDF-1.7"))).toBe(true);
    expect(hasPdfMagic(new TextEncoder().encode("%PDX-1.7"))).toBe(false);
  });

  it("allows an HTML dashboard larger than the text cap but not above its own cap", async () => {
    const html = `<!doctype html><script>const d=${JSON.stringify("x".repeat(40_000))}</script>`;
    expect((await verifyExpectedDeliverables(["dashboard.html"], [file("dashboard.html", html)]))[0]?.mediaType).toBe("text/html; charset=utf-8");
    await expect(verifyExpectedDeliverables(["dashboard.html"], [file("dashboard.html", "x".repeat(524_289))])).rejects.toThrow("exceeds");
    await expect(verifyExpectedDeliverables(["a.md"], [file("a.md", "x".repeat(16_385))])).rejects.toThrow("exceeds");
  });
});

describe("deliverable response headers", () => {
  const body = new TextEncoder().encode("<h1>hi</h1>").buffer;
  it("serves html with the sandbox CSP and nosniff", () => {
    const response = deliverableResponse("dashboard.html", body, { inline: true });
    expect(response.headers.get("content-security-policy")).toContain(HTML_DELIVERABLE_CSP);
    expect(HTML_DELIVERABLE_CSP).toBe("default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline' https://cdn.jsdelivr.net; connect-src 'none'; frame-ancestors 'self'");
    expect(response.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
    expect(response.headers.get("content-security-policy")).not.toContain("allow-same-origin");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-disposition")).toMatch(/^inline/);
  });
  it("downloads by default and never renders other types inline", () => {
    expect(deliverableResponse("dashboard.html", body).headers.get("content-disposition")).toMatch(/^attachment/);
    const csv = deliverableResponse("data.csv", body, { inline: true });
    expect(csv.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(csv.headers.get("x-content-type-options")).toBe("nosniff");
  });
  it("adds a print trigger only on request", async () => {
    expect(await deliverableResponse("d.html", body, { inline: true, print: true }).text()).toContain("print()");
    expect(await deliverableResponse("d.html", body, { inline: true }).text()).not.toContain("print()");
  });
  it("frames pdf only from the same origin", () => {
    const response = deliverableResponse("r.pdf", body, { inline: true });
    expect(response.headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
    expect(response.headers.get("content-type")).toBe("application/pdf");
  });
});

describe("share to room", () => {
  const ROOM = `room_${"a".repeat(24)}`;
  const html = "<h1>Dashboard</h1>";
  const bytes = new TextEncoder().encode(html);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const put = vi.fn(async () => ({}));
  const run = { status: "completed", sandboxId: "sb1", expectedDeliverables: ["dashboard.html"], deliverables: [{ path: "dashboard.html", bytes: bytes.length, sha256 }] };
  const env = () => ({
    AGENT_AUDIT: { prepare: () => ({ bind: () => ({ run: async () => ({}), first: async () => null }) }) },
    CodingOrchestrator: {},
    ATTACHMENTS: { put, delete: async () => {}, get: async () => ({ arrayBuffer: async () => bytes.slice().buffer }) },
  } as unknown as Env);
  const post = (auth = true) => new Request(`https://app.test/api/collaboration/rooms/${ROOM}/shared-deliverables`, {
    method: "POST", headers: { ...(auth ? { Authorization: "Bearer ok" } : {}), "content-type": "application/json" },
    body: JSON.stringify({ runId: "r1", index: 0 }),
  });
  beforeEach(() => {
    state.scope = { tenantId: "t", workspaceId: "w", userId: "me@x.test" };
    state.canRead = true; state.run = run; state.denied = null; state.messages.length = 0; put.mockClear();
  });

  it("requires authentication", async () => {
    expect((await handleCollaborationShare(post(false), env()))?.status).toBe(401);
  });
  it("refuses non-members and writes nothing", async () => {
    state.canRead = false;
    expect((await handleCollaborationShare(post(), env()))?.status).toBe(404);
    expect(put).not.toHaveBeenCalled();
    expect(state.messages).toHaveLength(0);
  });
  it("refuses runs the caller cannot read", async () => {
    state.denied = Response.json({}, { status: 404 });
    expect((await handleCollaborationShare(post(), env()))?.status).toBe(404);
    expect(state.messages).toHaveLength(0);
  });
  it("creates exactly one card message for a completed deliverable", async () => {
    const response = await handleCollaborationShare(post(), env());
    expect(response?.status).toBe(201);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ roomId: ROOM, body: "Shared dashboard.html", senderKind: "human" });
    expect(put).toHaveBeenCalledTimes(1);
  });
  it("notifies open room viewers when a deliverable is shared", async () => {
    const notify = vi.fn(async () => {});
    const sharedEnv = { ...env(), ConversationRoom: { getByName: () => ({ notifyCollaborationChange: notify }) } } as unknown as Env;
    const response = await handleCollaborationWithRealtime(post(), sharedEnv);
    expect(response?.status).toBe(201);
    expect(notify).toHaveBeenCalledWith({ tenantId: "t", workspaceId: "w", roomId: ROOM });
  });
  it("does not share an unfinished run", async () => {
    state.run = { ...run, status: "running" };
    expect((await handleCollaborationShare(post(), env()))?.status).toBe(404);
  });
  it("serves a shared card with the sandbox headers to a room member", async () => {
    const sharedEnv = {
      ...env(),
      AGENT_AUDIT: { prepare: () => ({ bind: () => ({ first: async () => ({ source_artifact_refs_json: JSON.stringify([{ index: 0, path: "dashboard.html", sha256, bytes: bytes.length }]) }) }) }) },
    } as unknown as Env;
    const get = new Request(`https://app.test/api/collaboration/rooms/${ROOM}/shared-deliverables/shared_${"b".repeat(24)}?inline=1`, { headers: { Authorization: "Bearer ok" } });
    const response = await handleCollaborationShare(get, sharedEnv);
    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-security-policy")).toContain("connect-src 'none'");
    state.canRead = false;
    expect((await handleCollaborationShare(get, sharedEnv))?.status).toBe(404);
  });
});
