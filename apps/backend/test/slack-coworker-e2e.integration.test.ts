/**
 * Slack coworker end-to-end coverage.
 *
 * Drives the real Worker router (`worker.fetch`) and the real
 * `CodingOrchestrator` Durable Object with signed Slack HTTP fixtures: the
 * install manifest, a threaded approval card, an approved run whose
 * deliverables are attached through Slack's external upload flow, a missing
 * `files:write` scope, a rejected approval, a revoked installation, and a
 * private employee-tool approval. The harness and Slack Web API are fixtures.
 */
import type { UIMessage } from "ai";
import { createHmac } from "node:crypto";
import { getAgentByName } from "agents/routing";
import { describe, expect, it, vi } from "vitest";
import { SLACK_BOT_SCOPES } from "@shiba/shared";
import { readFileSync } from "node:fs";
import type { Env } from "../src/env.js";
import { CodingOrchestrator, type OrchestratorState } from "../src/agents/orchestrator.js";
import { formatAgentResult, parseAgentToolInput } from "../src/opencode-input.js";
import { deliverableStorageKey, persistRunDeliverables, verifyExpectedDeliverables } from "../src/run-deliverables.js";
import { notifyEmployeeToolApprovalInChat } from "../src/chat-employee.js";
import { buildEmployeeToolApprovalValue } from "../src/slack-approval.js";
import { verifySlackBotInstallation } from "../src/slack.js";
import { createCustomAgent } from "../src/custom-agents-store.js";
import { requestEmployeeActionApproval } from "../src/employee-tool-store.js";
import { activeSlackInstallationForTeam } from "../src/slack-installations-store.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import { productionEnvStubs, setStateLikeProduction } from "./orchestrator-host.js";
import { setSandboxHandleResolver } from "../src/sandbox/lifecycle.js";
import worker from "../src/index.js";

vi.mock("agents/routing", () => ({ getAgentByName: vi.fn(), routeAgentRequest: vi.fn().mockResolvedValue(null) }));

const SIGNING_SECRET = "slack-coworker-fixture-signing-secret";
const TEAM = "T123";
const CHANNEL = "C123";
const THREAD_TS = "1758217392.000100";
const THREAD_NAME = `slack:${TEAM}:${CHANNEL}:${THREAD_TS}`;
const BOT_TOKEN = "xoxb-coworker-fixture-token";

const REPORT_PDF = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 72 72]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n";
/** Capture checks verify the Office Open XML package signature; the sandbox writes the workbook itself. */
const SALES_XLSX = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00]);

const DELIVERABLES = [
  { path: "report.pdf", content: Buffer.from(REPORT_PDF, "utf8").toString("base64"), encoding: "base64" as const },
  { path: "sales.xlsx", content: Buffer.from(SALES_XLSX).toString("base64"), encoding: "base64" as const },
];

const mocks = vi.hoisted(() => ({
  destroy: vi.fn(),
  execute: vi.fn(),
  specialist: vi.fn(),
  keepAliveWhile: vi.fn((fn: () => Promise<unknown>) => fn()),
  schedule: vi.fn(async (..._args: unknown[]) => ({})),
}));

vi.mock("@cloudflare/think", () => ({
  Think: class {
    messages?: UIMessage[];
    async addMessages(messages: UIMessage[]) {
      const ids = new Set(messages.map((message) => message.id));
      this.messages = [...(this.messages ?? []).filter((message) => !ids.has(message.id)), ...messages];
    }
    onStart() {}
    getTools() {
      return {};
    }
    onRequest() {
      return new Response(null, { status: 404 });
    }
    keepAliveWhile(fn: () => Promise<unknown>) {
      return mocks.keepAliveWhile(fn);
    }
    schedule(...args: unknown[]) {
      return mocks.schedule(...args);
    }
  },
}));
vi.mock("agents/agent-tools", () => ({ agentTool: (cls: { name: string }) => ({ execute: cls.name === "ReviewerAgent" ? mocks.specialist : mocks.execute }) }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
setSandboxHandleResolver(() => ({ destroy: mocks.destroy }));

interface StoredObject {
  bytes: Uint8Array<ArrayBuffer>;
  etag: string;
}

function memoryBucket() {
  const stored = new Map<string, StoredObject>();
  let version = 0;
  const bucket = {
    put: vi.fn(async (key: string, value: string | Uint8Array | ArrayBuffer, options?: R2PutOptions) => {
      const condition = options?.onlyIf as R2Conditional | undefined;
      if (condition?.etagDoesNotMatch === "*" && stored.has(key)) return null;
      if (condition?.etagMatches && condition.etagMatches !== stored.get(key)?.etag) return null;
      const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value.slice(0));
      const etag = String(++version);
      stored.set(key, { bytes, etag });
      return { key, size: bytes.byteLength, etag };
    }),
    get: vi.fn(async (key: string) => {
      const object = stored.get(key);
      return object ? {
        size: object.bytes.byteLength, etag: object.etag,
        arrayBuffer: async () => object.bytes.slice().buffer,
        text: async () => new TextDecoder().decode(object.bytes),
        json: async () => JSON.parse(new TextDecoder().decode(object.bytes)) as unknown,
      } : null;
    }),
    delete: vi.fn(async (key: string) => { stored.delete(key); }),
  } as unknown as R2Bucket;
  return { bucket, stored };
}

interface SlackCall {
  method: string;
  responseTs?: string;
  channel?: string;
  threadTs?: string;
  ts?: string;
  text?: string;
  blocks?: Array<{ elements?: Array<{ action_id: string; value: string }> }>;
  body: Record<string, unknown>;
}

interface SlackFixture {
  calls: SlackCall[];
  uploads: Array<{ filename: string; bytes: Uint8Array<ArrayBuffer>; contentType: string }>;
  completedUploads: Array<Record<string, unknown>>;
  responseUrls: Array<Record<string, unknown>>;
  scopes: () => string | null;
  setScopes: (value: string | null) => void;
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function slackFixture(scopes: string | null = "chat:write,app_mentions:read,files:write"): SlackFixture {
  let granted = scopes;
  const fixture: SlackFixture = {
    calls: [], uploads: [], completedUploads: [], responseUrls: [],
    scopes: () => granted,
    setScopes: (value) => { granted = value; },
  };
  let messageTs = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const json = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), {
      status: 200, headers: { "Content-Type": "application/json", ...headers },
    });
    if (url.origin === "https://slack.com" && url.pathname === "/api/auth.test") {
      return json({ ok: true, team_id: TEAM, user_id: "UBOT", bot_id: "BBOT" },
        fixture.scopes() === null ? {} : { "x-oauth-scopes": fixture.scopes()! });
    }
    if (url.origin === "https://slack.com" && url.pathname === "/api/conversations.replies") {
      return json({ ok: true, messages: [] });
    }
    if (url.origin === "https://slack.com" && (url.pathname === "/api/chat.postMessage" || url.pathname === "/api/chat.update")) {
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${BOT_TOKEN}`);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const record: SlackCall = {
        method: url.pathname.slice("/api/".length),
        ...(typeof body.channel === "string" ? { channel: body.channel } : {}),
        ...(typeof body.thread_ts === "string" ? { threadTs: body.thread_ts } : {}),
        ...(typeof body.ts === "string" ? { ts: body.ts } : {}),
        ...(typeof body.text === "string" ? { text: body.text } : {}),
        ...(Array.isArray(body.blocks) ? { blocks: body.blocks as SlackCall["blocks"] } : {}),
        body,
      };
      record.responseTs = `1758217399.${String(++messageTs).padStart(6, "0")}`;
      fixture.calls.push(record);
      return json({ ok: true, channel: body.channel ?? CHANNEL, ts: record.responseTs });
    }
    if (url.origin === "https://slack.com" && url.pathname === "/api/files.getUploadURLExternal") {
      fixture.calls.push({ method: "files.getUploadURLExternal", body: Object.fromEntries(url.searchParams) });
      return json({ ok: true, upload_url: `https://files.slack.com/upload/v1/${url.searchParams.get("filename")}`, file_id: `F-${url.searchParams.get("filename")}` });
    }
    if (url.origin === "https://files.slack.com" && url.pathname.startsWith("/upload/v1/")) {
      if (!(init?.body instanceof Uint8Array)) throw new Error("Slack file upload fixture expects raw bytes.");
      fixture.uploads.push({
        filename: url.pathname.slice("/upload/v1/".length),
        bytes: new Uint8Array(init.body),
        contentType: new Headers(init.headers).get("content-type") ?? "",
      });
      return new Response("OK");
    }
    if (url.origin === "https://slack.com" && url.pathname === "/api/files.completeUploadExternal") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      fixture.completedUploads.push(body);
      return json({ ok: true });
    }
    if (url.origin === "https://hooks.slack.com") {
      fixture.responseUrls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response("ok");
    }
    throw new Error(`Unstubbed Slack fixture destination: ${url.origin}${url.pathname}`);
  }));
  return fixture;
}

function replyAckMemory() {
  const seen = new Set<string>();
  return {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (request: Request) => {
        if (new URL(request.url).pathname !== "/internal/dedupe") return Response.json({ ok: true });
        const { key } = await request.json() as { key: string };
        const exists = seen.has(key);
        seen.add(key);
        return Response.json({ seen: exists });
      },
    }),
  } as unknown as Env["Automations"];
}

function env(overrides: Partial<Env> = {}): Env {
  return {
    ...productionEnvStubs(),
    Sandbox: {},
    SLACK_SIGNING_SECRET: SIGNING_SECRET,
    SLACK_BOT_TOKEN: BOT_TOKEN,
    SLACK_APPROVERS: "UAPPROVER",
    ATTACHMENTS: memoryBucket().bucket,
    ...overrides,
  } as Env;
}

function orchestrator(instanceEnv: Env, name: string) {
  return Object.assign(Object.create(CodingOrchestrator.prototype) as CodingOrchestrator, {
    env: instanceEnv,
    name,
    messages: [],
    state: { runs: [] } as OrchestratorState,
    setState(state: OrchestratorState) {
      setStateLikeProduction(this, state);
    },
  });
}

/** Completes the harness call with the two verified deliverables persisted to the run's bucket. */
function wireDeliverableHarness(attachments: R2Bucket) {
  mocks.execute.mockImplementation(async (text: string) => {
    const input = parseAgentToolInput([{ role: "user", text }]);
    expect(input.expectedDeliverables).toEqual(["report.pdf", "sales.xlsx"]);
    expect(input.repoUrl).toBe("");
    const files = DELIVERABLES.map((file) => ({ ...file }));
    const artifacts = await verifyExpectedDeliverables(input.expectedDeliverables, files);
    const deliverables = await persistRunDeliverables({ ATTACHMENTS: attachments }, input.sandboxId, artifacts);
    return formatAgentResult({
      status: "completed", exitCode: 0, stderrTail: "", changedFiles: files.map((file) => file.path),
      diff: "", files, deliverables, summary: "Filed the quarterly sales report and workbook.",
    });
  });
}

async function sendSlack(
  instance: CodingOrchestrator,
  path: string,
  body: string,
  options: { secret?: string } = {},
) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", options.secret ?? SIGNING_SECRET).update(`v0:${timestamp}:${body}`).digest("hex");
  const pending: Promise<unknown>[] = [];
  const request = new Request(`https://shiba.test/api/slack/${path}`, {
    method: "POST",
    body,
    headers: {
      "content-type": path === "events" ? "application/json" : "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": String(timestamp),
      "x-slack-signature": `v0=${signature}`,
    },
  });
  const response = await worker.fetch(request, (instance as unknown as { env: Env }).env, {
    waitUntil: (promise: Promise<unknown>) => pending.push(promise),
  } as unknown as Parameters<typeof worker.fetch>[2]);
  await Promise.all(pending);
  return response;
}

function mentionEvent(eventId: string, text: string, options: { ts?: string; threadTs?: string } = {}) {
  return JSON.stringify({
    type: "event_callback", event_id: eventId, api_app_id: "A123", team_id: TEAM,
    event: {
      type: "app_mention", channel: CHANNEL, user: "UREQUESTER",
      ts: options.ts ?? THREAD_TS,
      ...(options.threadTs ? { thread_ts: options.threadTs } : {}),
      text,
    },
  });
}

function approvalClick(blockValue: string, actionId: string, options: { userId?: string; actionValue?: string; ts?: string } = {}) {
  return new URLSearchParams({
    payload: JSON.stringify({
      type: "block_actions", api_app_id: "A123", team: { id: TEAM }, channel: { id: CHANNEL },
      user: { id: options.userId ?? "UAPPROVER" },
      response_url: "https://hooks.slack.com/actions/fixture",
      message: { ts: "1758217399.000001", thread_ts: options.ts ?? THREAD_TS },
      actions: [{ action_id: actionId, value: options.actionValue ?? blockValue }],
    }),
  }).toString();
}

/** The card the mention handler delivered for this thread, whether posted or edited into the interim receipt. */
function approvalCard(fixture: SlackFixture, fromIndex = 0) {
  const card = fixture.calls.slice(fromIndex).find((call) => call.channel === CHANNEL &&
    call.blocks?.some((block) => block.elements?.some((element) => element.action_id === "approve")));
  expect(card, "approval card in the originating Slack thread").toBeDefined();
  const approve = card!.blocks!.flatMap((block) => block.elements ?? []).find((element) => element.action_id === "approve")!;
  const pointer = JSON.parse(approve.value) as { threadKey: string; approvalId: string };
  return { card: card!, value: approve.value, pointer };
}

async function signedInteract(instance: CodingOrchestrator, form: string, secret = SIGNING_SECRET) {
  return sendSlack(instance, "interact", form, { secret });
}

async function waitForCompletion(instance: CodingOrchestrator, runId: string) {
  await vi.waitFor(() => {
    const run = instance.state.runs.find((item) => item.runId === runId);
    if (run?.status === "error") throw new Error(run.error ?? "Slack coworker run failed.");
    expect(run?.status).toBe("completed");
  }, { timeout: 15_000 });
  return instance.state.runs.find((item) => item.runId === runId)!;
}

async function seedSalesEmployee(envLike: Env, slug = "sales-reporter") {
  return createCustomAgent(envLike, "self-hosted", slug, {
    name: "Sales reporter",
    instructions: "Prepare the quarterly sales report.",
    harness: "opencode",
    expectedDeliverables: ["report.pdf", "sales.xlsx"],
  });
}

describe("slack coworker end-to-end", () => {
  it("ships a manifest with files:write and reads granted scopes from auth.test", async () => {
    const manifest = readFileSync(new URL("../../../slack-app-manifest.yaml", import.meta.url), "utf8");
    const scopesBlock = manifest.slice(manifest.indexOf("  scopes:"), manifest.indexOf("settings:"));
    const manifestScopes = scopesBlock.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("- "))
      .map((line) => line.slice(2).trim());
    expect(manifestScopes).toContain("files:write");
    expect(SLACK_BOT_SCOPES).toContain("files:write");

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, team_id: TEAM, user_id: "UBOT", bot_id: "BBOT" },
      { headers: { "x-oauth-scopes": "chat:write, app_mentions:read ,files:write" } })));
    try {
      await expect(verifySlackBotInstallation(BOT_TOKEN)).resolves.toEqual({
        teamId: TEAM, userId: "UBOT", botId: "BBOT", scopes: ["chat:write", "app_mentions:read", "files:write"],
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("approves a threaded mention, then attaches both deliverables to the originating thread", async () => {
    const { database } = customAgentD1();
    const attachments = memoryBucket();
    const fixture = slackFixture();
    const instanceEnv = env({ AGENT_AUDIT: database, Automations: replyAckMemory(), ATTACHMENTS: attachments.bucket });
    const instance = orchestrator(instanceEnv, THREAD_NAME);
    vi.mocked(getAgentByName).mockImplementation(async (_namespace, name) => {
      expect(name).toBe(THREAD_NAME);
      return { fetch: (request: Request) => instance.onRequest(request) } as never;
    });
    wireDeliverableHarness(attachments.bucket);
    await seedSalesEmployee(instanceEnv);

    const request = mentionEvent("EvMentionJourney", "<@UBOT> employee:sales-reporter file the quarterly sales report", { threadTs: THREAD_TS });
    expect((await sendSlack(instance, "events", request, { secret: "wrong-fixture-key" })).status).toBe(401);
    expect((await sendSlack(instance, "events", request)).status).toBe(200);

    // The card lands in the originating thread and nothing runs before approval.
    const { card, value, pointer } = approvalCard(fixture);
    expect(card.channel).toBe(CHANNEL);
    if (card.method === "chat.postMessage") {
      expect(card.threadTs).toBe(THREAD_TS);
    } else {
      const receipt = fixture.calls.find((call) => call.method === "chat.postMessage" && call.text === "Working on it…");
      expect(receipt?.threadTs).toBe(THREAD_TS);
      expect(card.ts).toBe(receipt?.responseTs);
    }
    expect(pointer.threadKey).toBe(THREAD_NAME);
    expect(instance.state.pendingApprovals).toContainEqual(expect.objectContaining({ approvalId: pointer.approvalId, status: "pending" }));
    expect(instance.state.runs).toHaveLength(0);
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.destroy).not.toHaveBeenCalled();

    // A signed, allowlisted approve click starts exactly one run.
    const response = await signedInteract(instance, approvalClick(value, "approve"));
    expect(response.status).toBe(200);
    const run = await waitForCompletion(instance, `agent-tool:${pointer.approvalId}`);
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(run.deliverables).toEqual([
      expect.objectContaining({ path: "report.pdf", mediaType: "application/pdf" }),
      expect.objectContaining({ path: "sales.xlsx", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
    ]);

    // Completion text and both attachments land in the originating thread.
    await vi.waitFor(() => expect(fixture.uploads).toHaveLength(2), { timeout: 15_000 });
    expect(fixture.calls).toContainEqual(expect.objectContaining({
      method: "chat.postMessage", channel: CHANNEL, threadTs: THREAD_TS,
      text: expect.stringContaining("Filed the quarterly sales report and workbook."),
    }));
    const expectedBytes = new Map([
      ["report.pdf", Buffer.from(REPORT_PDF, "utf8")],
      ["sales.xlsx", Buffer.from(SALES_XLSX)],
    ]);
    for (const upload of fixture.uploads) {
      expect(expectedBytes.has(upload.filename), upload.filename).toBe(true);
      expect(Buffer.from(upload.bytes)).toEqual(expectedBytes.get(upload.filename));
      expect(upload.contentType).toBe(upload.filename === "report.pdf"
        ? "application/pdf"
        : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    }
    expect(fixture.completedUploads).toHaveLength(2);
    for (const completed of fixture.completedUploads) {
      expect(completed).toMatchObject({ channel_id: CHANNEL, thread_ts: THREAD_TS });
    }
    expect(fixture.completedUploads.map((completed) => (completed.files as Array<{ title: string }>)[0]!.title).sort())
      .toEqual(["report.pdf", "sales.xlsx"]);

    // Stored deliverable bytes carry the checksums Slack received.
    for (const [index, deliverable] of run.deliverables!.entries()) {
      const stored = attachments.stored.get(deliverableStorageKey(run.sandboxId, deliverable.sha256, index));
      expect(stored).toBeDefined();
      expect(await sha256Hex(stored!.bytes)).toBe(deliverable.sha256);
      expect((await sha256Hex(expectedBytes.get(deliverable.path)!))).toBe(deliverable.sha256);
    }
    vi.unstubAllGlobals();
  }, 30_000);

  it("keeps the text reply and names files:write once when the scope is missing, then attaches after a reinstall", async () => {
    const { database } = customAgentD1();
    const attachments = memoryBucket();
    const fixture = slackFixture("chat:write,app_mentions:read");
    const instanceEnv = env({ AGENT_AUDIT: database, Automations: replyAckMemory(), ATTACHMENTS: attachments.bucket });
    const threads = new Map<string, CodingOrchestrator>();
    const instanceFor = (threadTs: string) => {
      const name = `slack:${TEAM}:${CHANNEL}:${threadTs}`;
      const existing = threads.get(name);
      if (existing) return existing;
      const created = orchestrator(instanceEnv, name);
      threads.set(name, created);
      return created;
    };
    vi.mocked(getAgentByName).mockImplementation(async (_namespace, name) => {
      const instance = threads.get(String(name));
      expect(instance, `orchestrator ${String(name)}`).toBeDefined();
      return { fetch: (request: Request) => instance!.onRequest(request) } as never;
    });
    wireDeliverableHarness(attachments.bucket);
    await seedSalesEmployee(instanceEnv);

    // The app is installed without files:write, so only the text reply can land.
    const limitedThread = "1758217392.000100";
    const limited = instanceFor(limitedThread);
    expect((await sendSlack(limited, "events", mentionEvent("EvMissingScope", "<@UBOT> employee:sales-reporter file the quarterly sales report", { ts: "1758217392.000200", threadTs: limitedThread }))).status).toBe(200);
    const limitedCard = approvalCard(fixture);
    expect((await signedInteract(limited, approvalClick(limitedCard.value, "approve", { ts: limitedThread }))).status).toBe(200);
    const limitedRun = await waitForCompletion(limited, `agent-tool:${limitedCard.pointer.approvalId}`);

    await vi.waitFor(() => expect(fixture.calls).toContainEqual(expect.objectContaining({
      method: "chat.postMessage", channel: CHANNEL, threadTs: limitedThread,
      text: expect.stringContaining("Filed the quarterly sales report and workbook."),
    })), { timeout: 15_000 });
    const guidance = fixture.calls.filter((call) => call.text?.includes("files:write"));
    expect(guidance).toHaveLength(1);
    expect(guidance[0]!.text).toMatch(/reinstall/i);
    expect(fixture.calls.filter((call) => call.method === "files.getUploadURLExternal")).toHaveLength(0);
    expect(fixture.completedUploads).toHaveLength(0);
    // A missing scope is a refusal, not an uncertain send: no per-file receipt was claimed.
    const receipts = [...attachments.stored.keys()].filter((key) => key.startsWith("channel-output-receipts/"));
    expect(receipts).toHaveLength(1);
    for (const key of receipts) expect(JSON.parse(new TextDecoder().decode(attachments.stored.get(key)!.bytes))).toEqual({ state: "attempting" });

    // After the admin reinstalls the app with files:write, a later delivery attaches cleanly.
    fixture.setScopes("chat:write,app_mentions:read,files:write");
    const reauthorizedThread = "1758217392.000300";
    const reauthorized = instanceFor(reauthorizedThread);
    const cardMark = fixture.calls.length;
    expect((await sendSlack(reauthorized, "events", mentionEvent("EvReinstalledScope", "<@UBOT> employee:sales-reporter file the quarterly sales report", { ts: "1758217392.000400", threadTs: reauthorizedThread }))).status).toBe(200);
    const reauthorizedCard = approvalCard(fixture, cardMark);
    expect(reauthorizedCard.pointer.threadKey).toBe(`slack:${TEAM}:${CHANNEL}:${reauthorizedThread}`);
    expect((await signedInteract(reauthorized, approvalClick(reauthorizedCard.value, "approve", { ts: reauthorizedThread }))).status).toBe(200);
    const reauthorizedRun = await waitForCompletion(reauthorized, `agent-tool:${reauthorizedCard.pointer.approvalId}`);
    expect(reauthorizedRun.runId).not.toBe(limitedRun.runId);
    await vi.waitFor(() => expect(fixture.uploads).toHaveLength(2), { timeout: 15_000 });
    expect(fixture.completedUploads).toHaveLength(2);
    for (const completed of fixture.completedUploads) expect(completed).toMatchObject({ channel_id: CHANNEL, thread_ts: reauthorizedThread });
    vi.unstubAllGlobals();
  }, 30_000);

  it("records a rejected approval on the card and starts no sandbox", async () => {
    const { database } = customAgentD1();
    const fixture = slackFixture();
    const attachments = memoryBucket();
    const instanceEnv = env({ AGENT_AUDIT: database, Automations: replyAckMemory(), ATTACHMENTS: attachments.bucket });
    const instance = orchestrator(instanceEnv, THREAD_NAME);
    vi.mocked(getAgentByName).mockImplementation(async (_namespace, name) => {
      expect(name).toBe(THREAD_NAME);
      return { fetch: (request: Request) => instance.onRequest(request) } as never;
    });
    wireDeliverableHarness(attachments.bucket);
    await seedSalesEmployee(instanceEnv);

    expect((await sendSlack(instance, "events", mentionEvent("EvRejection", "<@UBOT> employee:sales-reporter file the quarterly sales report", { ts: "1758217392.000400", threadTs: THREAD_TS }))).status).toBe(200);
    const { value } = approvalCard(fixture);
    expect((await signedInteract(instance, approvalClick(value, "reject", { ts: THREAD_TS }))).status).toBe(200);

    await vi.waitFor(() => expect(fixture.responseUrls).toContainEqual(expect.objectContaining({
      replace_original: true, text: expect.stringMatching(/rejected/i),
    })), { timeout: 15_000 });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.destroy).not.toHaveBeenCalled();
    expect(instance.state.runs.filter((item) => item.status === "completed")).toHaveLength(0);
    expect(fixture.uploads).toHaveLength(0);
    vi.unstubAllGlobals();
  }, 30_000);

  it("fails closed after a workspace-owner installation is uninstalled, with no operator-token fallback", async () => {
    const { database, sqlite } = customAgentD1();
    const fixture = slackFixture();
    sqlite.exec(`INSERT INTO "user"(id,email,emailVerified,name,createdAt,updatedAt) VALUES('account-fixture','owner@example.test',1,'Fixture',1,1);
      INSERT INTO shiba_auth_account_policy(account_id,email,kind,invitation_id,workspace_id) VALUES('account-fixture','owner@example.test','invited','fixture-invite','ws-fixture');
      INSERT INTO team_workspaces(tenant_id,workspace_id,name,version,created_at) VALUES('self-hosted','ws-fixture','Owner workspace',1,1);
      INSERT INTO team_workspace_memberships(tenant_id,workspace_id,user_id,role,status,version,joined_at) VALUES('self-hosted','ws-fixture','owner@example.test','owner','active',1,1);
      INSERT INTO slack_installations(id,workspace_id,owner_id,owner_account_id,owner_member_json,app_id,team_id,bot_user_id,bot_id,installer_slack_user_id,scopes_json,generation,version,token_revision,state,digest,token_key_id,token_cipher,token_expires_at,activation_expires_at,created_at,refresh_claim_id)
      VALUES('inst-fixture','ws-fixture','owner@example.test','account-fixture',
        '{"workspaceId":"ws-fixture","userId":"owner@example.test","accountId":"account-fixture","version":1,"role":"owner","joinedAt":0}',
        'A123','T123','UB123','B123','UINSTALLER','["chat:write","app_mentions:read","files:write"]',1,1,1,'active','fixture-digest','v1','fixture-cipher',NULL,9999999999999,1,NULL);`);
    const instanceEnv = env({
      AGENT_AUDIT: database,
      SLACK_INSTALLATIONS_ENABLED: "true",
      SLACK_OAUTH_APP_ID: "A123",
      ATTACHMENTS: memoryBucket().bucket,
    });
    const instance = orchestrator(instanceEnv, THREAD_NAME);
    const installed = await activeSlackInstallationForTeam(instanceEnv, "A123", TEAM);
    expect(installed).toMatchObject({ id: "inst-fixture", teamId: TEAM, generation: 1 });

    const uninstall = JSON.stringify({
      type: "event_callback", api_app_id: "A123", team_id: TEAM, event_id: "EvUninstalled",
      event: { type: "app_uninstalled" },
    });
    expect((await sendSlack(instance, "events", uninstall)).status).toBe(200);
    expect(await activeSlackInstallationForTeam(instanceEnv, "A123", TEAM)).toBeNull();

    const callsBefore = fixture.calls.length;
    const interact = await signedInteract(instance, approvalClick(`{"kind":"run","threadKey":"${THREAD_NAME}","approvalId":"fixture-approval"}`, "approve"));
    expect(interact.status).toBe(200);
    expect(await interact.json()).toMatchObject({ response_type: "ephemeral", text: expect.stringMatching(/installation is unavailable/i) });
    const events = await sendSlack(instance, "events", mentionEvent("EvAfterUninstall", "<@UBOT> employee:sales-reporter file the quarterly sales report", { ts: "1758217392.000500", threadTs: THREAD_TS }));
    expect(events.status).toBe(200);
    expect(await events.text()).toBe("");
    expect(mocks.execute).not.toHaveBeenCalled();
    // No operator bot token fallback: nothing is posted with the legacy credential.
    expect(fixture.calls.slice(callsBefore)).toHaveLength(0);
    vi.unstubAllGlobals();
  }, 30_000);

  it("shows only dashboard Tool policy guidance for a private employee approval and refuses the Slack decision", async () => {
    const { database, sqlite } = customAgentD1();
    const fixture = slackFixture();
    const instanceEnv = env({ AGENT_AUDIT: database });
    const instance = orchestrator(instanceEnv, THREAD_NAME);
    vi.mocked(getAgentByName).mockImplementation(async (_namespace, name) => {
      expect(name).toBe(THREAD_NAME);
      return { fetch: (request: Request) => instance.onRequest(request) } as never;
    });
    const employee = await createCustomAgent(instanceEnv, "self-hosted", "reader", { name: "Reader", instructions: "Read mail.", harness: "opencode" });
    const pending = await requestEmployeeActionApproval(instanceEnv, {
      orgId: "self-hosted", employeeId: employee.id, employeeVersion: employee.version,
      actorId: "owner@example.test", connectionId: "conn-1", connectionGeneration: 1,
      capability: { kind: "mcp", id: "mcp:shiba:gmail_read" }, action: "gmail_read",
      argumentDigest: "abc", payload: { messageIds: ["fixture-private-message"] },
      policyVersion: "current", expiresAt: Date.now() + 60_000, executionContextId: THREAD_NAME,
    });

    await notifyEmployeeToolApprovalInChat(instanceEnv, pending);
    const guidance = fixture.calls.filter((call) => call.channel === CHANNEL);
    expect(guidance).toHaveLength(1);
    expect(guidance[0]!.text).toBe("A private employee tool call needs approval. The connected account owner can review it in the dashboard under Tool policy.");
    expect(guidance[0]!.blocks).toBeUndefined();
    expect(JSON.stringify(guidance[0]!.body)).not.toMatch(/fixture-private-message|eap-/);

    const decision = buildEmployeeToolApprovalValue({
      kind: "employee_tool", threadKey: THREAD_NAME, approvalId: pending.approvalId,
      employeeId: employee.id, orgId: "self-hosted",
    });
    const response = await signedInteract(instance, approvalClick(decision, "employee_approve", { ts: THREAD_TS }));
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(fixture.responseUrls).toContainEqual(expect.objectContaining({
      text: expect.stringMatching(/connected account owner/i),
    })), { timeout: 15_000 });
    expect(sqlite.prepare("SELECT status, decided_by FROM employee_tool_approvals WHERE approval_id = ?").get(pending.approvalId))
      .toMatchObject({ status: "pending", decided_by: null });
    expect(mocks.execute).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  }, 30_000);
});
