import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildSessionAgentName } from "../src/web-sessions.js";
import { handleRuns } from "../src/runs-routes.js";
import { persistRunDeliverables, verifyExpectedDeliverables, deliverableStorageKey } from "../src/run-deliverables.js";
import type { Env } from "../src/env.js";

const state = vi.hoisted(() => ({
  runs: new Map<string, Record<string, unknown>>(), sessions: new Map<string, string[]>(), requests: [] as Request[],
}));
vi.mock("../src/request-auth.js", () => ({
  isAuthorizedRequest: async (request: Request) => request.headers.get("Authorization") === "Bearer fixture",
  resolveUserId: async (request: Request) => request.headers.get("X-Fixture-User") ?? "owner-a",
}));
vi.mock("agents/routing", () => ({
  getAgentByName: async (_namespace: unknown, actor: string) => ({ fetch: async (request: Request | string) => {
    const url = new URL(typeof request === "string" ? request : request.url);
    if (url.pathname.startsWith("/internal/web-sessions/")) {
      const id = decodeURIComponent(url.pathname.split("/").pop()!);
      return state.sessions.get(actor)?.includes(id) ? Response.json({ session: { id } }) : Response.json({ error: "Session not found." }, { status: 404 });
    }
    if (typeof request !== "string") state.requests.push(request);
    const runId = decodeURIComponent(url.pathname.split("/").pop()!);
    const run = state.runs.get(actor+"|"+runId);
    return run ? Response.json({ run }) : Response.json({ error: "Run not found." }, { status: 404 });
  } }),
}));

const SESSION = "11111111-1111-4111-8111-111111111111";
let objects: Map<string, Uint8Array>;
let env: Env;
let get: ReturnType<typeof vi.fn>;
beforeEach(() => {
  state.runs.clear(); state.sessions.clear(); state.requests.length = 0;
  objects = new Map();
  get = vi.fn(async (key: string) => {
    const bytes = objects.get(key);
    return bytes ? { size: bytes.byteLength, arrayBuffer: async () => Uint8Array.from(bytes).buffer } : null;
  });
  env = { CodingOrchestrator: {}, DASHBOARD_APPROVERS: "owner-a", ATTACHMENTS: {
    get, put: async (key: string, value: string) => { objects.set(key, new TextEncoder().encode(value)); return { key }; },
  } } as unknown as Env;
});
async function seed(actor = "owner-a", text = "# Draft\nApproved workspace report\n", runId = "same-run") {
  const files = [{ path: "reports/brief.md", content: text, encoding: "utf8" as const }];
  const artifacts = await verifyExpectedDeliverables([files[0]!.path], files);
  const deliverables = await persistRunDeliverables(env, "same-sandbox", artifacts);
  const run = { runId, sandboxId: "same-sandbox", status: "completed", expectedDeliverables: [files[0]!.path], deliverables };
  state.runs.set(actor+"|"+runId, run);
  return { run, key: deliverableStorageKey(run.sandboxId, deliverables[0]!.sha256, 0), text };
}
function request(path = "/api/runs/same-run/deliverables/0", user = "owner-a", method = "GET", authenticated = true) {
  return new Request("https://dashboard.test"+path, { method, headers: {
    ...(authenticated ? { Authorization: "Bearer fixture" } : {}), "X-Fixture-User": user,
    "X-Agent-Principal": "spoofed-owner", "X-Shiba-Intake": "forged",
  } });
}

describe("authenticated requested-deliverable downloads", () => {
  it("downloads exact requested bytes as an attachment after owner lookup and hash validation", async () => {
    const { text } = await seed();
    const response = await handleRuns(request("/api/runs/same-run/deliverables/0?key=other-owner/private"), env);
    expect(response?.status).toBe(200);
    expect(await response!.text()).toBe(text);
    expect(response!.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(response!.headers.get("content-disposition")).toBe('attachment; filename="brief.md"');
    expect(response!.headers.get("cache-control")).toContain("no-store");
    expect(response!.headers.get("x-content-type-options")).toBe("nosniff");
    expect(state.requests[0]?.headers.has("X-Agent-Principal")).toBe(false);
  });

  it("ignores forged manifest MIME and serves only the declared safe attachment media type", async () => {
    const { run } = await seed();
    run.deliverables[0]!.mediaType = "text/html";
    const response = await handleRuns(request(), env);
    expect(response?.status).toBe(200);
    expect(response!.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(response!.headers.get("content-disposition")).toContain("attachment;");
  });

  it("requires authentication and never reads storage for anonymous or foreign owners", async () => {
    await seed();
    expect((await handleRuns(request(undefined, undefined, "GET", false), env))?.status).toBe(401);
    expect((await handleRuns(request(undefined, "owner-b"), env))?.status).toBe(404);
    expect(get).not.toHaveBeenCalled();
  });

  it("requires the exact registered named session; no default, foreign-session or shared fallback", async () => {
    const actor = buildSessionAgentName("owner-a", SESSION);
    await seed(actor);
    state.sessions.set("owner-a", [SESSION]);
    expect((await handleRuns(request(), env))?.status).toBe(404);
    expect((await handleRuns(request("/api/runs/same-run/deliverables/0?session="+SESSION, "owner-b"), env))?.status).toBe(404);
    const scoped = await handleRuns(request("/api/runs/same-run/deliverables/0?session="+SESSION), env);
    expect(scoped?.status).toBe(200);
    state.runs.clear(); await seed("default");
    expect((await handleRuns(request(), env))?.status).toBe(404);
  });

  it("keeps same run/sandbox identifiers isolated across owners by manifest and content-addressed storage", async () => {
    const a = await seed("owner-a", "owner A draft");
    const b = await seed("owner-b", "owner B draft");
    expect(a.key).not.toBe(b.key);
    expect(await (await handleRuns(request(), env))!.text()).toBe(a.text);
    expect(await (await handleRuns(request(undefined, "owner-b"), env))!.text()).toBe(b.text);
  });

  it.each(["-1", "8", "1.0", "../private", "%ZZ"])("refuses malformed ordinal %s", async (index) => {
    await seed();
    const result = await handleRuns(request("/api/runs/same-run/deliverables/"+index), env);
    expect(result === null || result.status === 400 || result.status === 404).toBe(true);
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects writes, missing ordinal, cancelled/error manifests and protected/undeclared paths", async () => {
    const { run } = await seed();
    expect((await handleRuns(request(undefined, undefined, "POST"), env))?.status).toBe(405);
    expect((await handleRuns(request("/api/runs/same-run/deliverables/1"), env))?.status).toBe(404);
    for (const status of ["cancelled", "error", "unknown"]) {
      state.runs.set("owner-a|same-run", { ...run, status });
      expect((await handleRuns(request(), env))?.status).toBe(404);
    }
    state.runs.set("owner-a|same-run", { ...run, expectedDeliverables: [".git/config"], deliverables: [{ ...run.deliverables[0], path: ".git/config" }] });
    expect((await handleRuns(request(), env))?.status).toBe(404);
    expect(get).not.toHaveBeenCalled();
  });

  it.each(["missing", "length", "hash"])("refuses %s stored bytes without serving corrupt/foreign content", async (damage) => {
    const { key, text } = await seed();
    if (damage === "missing") objects.delete(key);
    else objects.set(key, new TextEncoder().encode(damage === "length" ? text+"extra" : "X"+text.slice(1)));
    const response = await handleRuns(request(), env);
    expect(response?.status).toBe(damage === "missing" ? 404 : 409);
    expect(await response!.text()).not.toContain("Approved workspace report");
  });
});
