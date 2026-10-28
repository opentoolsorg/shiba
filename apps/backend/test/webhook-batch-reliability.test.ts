import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("agents/routing", () => ({ getAgentByName: vi.fn() }));
vi.mock("../src/slack-routes.js", () => ({ ORCHESTRATOR_NAME: "default" }));

import { getAgentByName } from "agents/routing";
import { Automations, type AutomationsState, type OrchestratorStub } from "../src/automations-do.js";
import { createAutomation, type Automation } from "../src/automations.js";
import type { Env } from "../src/env.js";

const NOW = Date.UTC(2026, 9, 28, 10, 0);
const REPO = "https://github.com/owner/repo";
const BATCH_KEY = "webhook-batch:batched";

class Storage {
  readonly data = new Map<string, unknown>();
  failBatchDelete = false;

  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.data.get(key)) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 128 * 1024) {
      throw new Error("Durable Object value exceeds 128 KiB");
    }
    this.data.set(key, structuredClone(value));
  }
  async delete(key: string): Promise<boolean> {
    if (key === BATCH_KEY && this.failBatchDelete) {
      this.failBatchDelete = false;
      throw new Error("storage acknowledgement interrupted");
    }
    return this.data.delete(key);
  }
  async list<T>({ prefix }: { prefix: string }): Promise<Map<string, T>> {
    return new Map([...this.data].filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => [key, structuredClone(value) as T]));
  }
  async transaction<T>(callback: (transaction: Storage) => Promise<T>): Promise<T> {
    const snapshot = structuredClone(this.data);
    try { return await callback(this); }
    catch (error) {
      this.data.clear();
      for (const [key, value] of snapshot) this.data.set(key, value);
      throw error;
    }
  }
}

function fixture(overrides: Partial<Automation> = {}) {
  const item = {
    ...createAutomation({
      id: "batched", prompt: "Triage", repoUrl: REPO,
      triggers: [{ kind: "webhook", batchWindowSeconds: 10 }],
    }).automation,
    ...overrides,
  };
  const storage = new Storage();
  storage.data.set("state", { items: [item] });
  const env = { AUTOMATIONS_ENABLED: "true", AI: {}, ORCHESTRATOR_MODEL: "@cf/test/model" } as unknown as Env;
  const ctx = { storage } as unknown as DurableObjectState;
  const instance = new Automations(ctx, env);
  const fetch = vi.fn<OrchestratorStub["fetch"]>(async () => Response.json({ approvalId: "pending" }));
  const orchestrator = { fetch };
  vi.mocked(getAgentByName).mockResolvedValue(orchestrator as never);
  const recreate = () => new Automations(ctx, env);
  const webhook = (body = "payload") => instance.fetch(new Request(`https://internal/api/automations/${item.id}/trigger`, {
    method: "POST", headers: { "x-automation-secret": item.webhookSecret! }, body,
  }));
  const due = () => storage.data.set(BATCH_KEY, { bodies: ["payload"], firstAt: NOW - 10_000, windowSeconds: 10 });
  return { instance, storage, orchestrator, fetch, webhook, due, recreate, env };
}

afterEach(() => vi.restoreAllMocks());

describe("durable webhook batches", () => {
  it("retains a transiently failed batch, backs off, and retries the same command after restart", async () => {
    const h = fixture(); h.due();
    h.fetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
    expect(await h.instance.tick(h.orchestrator, NOW)).toEqual({ fired: 0 });
    expect(h.storage.data.has(BATCH_KEY)).toBe(true);
    const first = await h.fetch.mock.calls[0]![0].clone().json() as { commandId: string; task: string };
    expect(first.commandId).toBeTruthy();
    const edited = (await h.storage.get<AutomationsState>("state"))!;
    edited.items[0] = { ...edited.items[0]!, prompt: "Edited prompt", repoUrl: "https://github.com/other/repo", customAgentId: "edited-agent" };
    await h.storage.put("state", edited);
    expect(await h.recreate().tick(h.orchestrator, NOW + 1)).toEqual({ fired: 0 });
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(await h.recreate().tick(h.orchestrator, NOW + 300_000)).toEqual({ fired: 1 });
    const second = await h.fetch.mock.calls[1]![0].clone().json() as { commandId: string; task: string };
    expect(second).toEqual(first);
    expect(h.storage.data.has(BATCH_KEY)).toBe(false);
    expect((await h.storage.get<AutomationsState>("state"))!.items[0]!.runCount).toBe(1);
  });

  it("deduplicates an ambiguous transport failure without minting another approval", async () => {
    const h = fixture(); h.due();
    const approvals = new Map<string, string>();
    h.fetch.mockImplementation(async (request) => {
      const input = await request.clone().json() as { commandId: string };
      const exists = approvals.has(input.commandId);
      if (!exists) approvals.set(input.commandId, "approval-1");
      if (!exists) throw new Error("response lost after durable queue commit");
      return Response.json({ approvalId: approvals.get(input.commandId), deduped: true });
    });
    await h.instance.tick(h.orchestrator, NOW);
    expect(h.storage.data.has(BATCH_KEY)).toBe(true);
    expect(await h.recreate().tick(h.orchestrator, NOW + 300_000)).toEqual({ fired: 1 });
    expect(approvals.size).toBe(1);
    expect(h.storage.data.has(BATCH_KEY)).toBe(false);
  });

  it("consumes permanent invalid queue input with a visible skip instead of retrying forever", async () => {
    const h = fixture(); h.due();
    h.fetch.mockResolvedValue(new Response(null, { status: 400 }));
    expect(await h.instance.tick(h.orchestrator, NOW)).toEqual({ fired: 0 });
    expect(h.storage.data.has(BATCH_KEY)).toBe(false);
    expect((await h.storage.get<AutomationsState>("state"))!.items[0]!.lastSkip?.reason).toContain("400");
    await h.instance.tick(h.orchestrator, NOW + 300_000);
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it("commits the run charge and batch acknowledgement atomically across storage failure", async () => {
    const h = fixture(); h.due();
    const approvals = new Set<string>();
    h.fetch.mockImplementation(async (request) => {
      const input = await request.clone().json() as { commandId: string };
      approvals.add(input.commandId);
      return Response.json({ approvalId: "pending" });
    });
    h.storage.failBatchDelete = true;
    await expect(h.instance.tick(h.orchestrator, NOW)).rejects.toMatchObject({ message: "storage acknowledgement interrupted" });
    expect(h.storage.data.has(BATCH_KEY)).toBe(true);
    expect((await h.storage.get<AutomationsState>("state"))!.items[0]!.runCount).toBe(1);
    await h.recreate().tick(h.orchestrator, NOW + 300_000);
    expect(approvals.size).toBe(1);
    expect((await h.storage.get<AutomationsState>("state"))!.items[0]!.runCount).toBe(1);
    expect(h.storage.data.has(BATCH_KEY)).toBe(false);
  });

  it.each([409, 503])("retries unattended resolution failure %i using its saved approval and charges the run only once", async (status) => {
    const h = fixture({ unattended: true, unattendedRepos: ["owner/repo"], dailyRunLimit: 1 }); h.due();
    h.env.GITHUB_TOKEN = "test-only-github-token";
    let resolves = 0;
    h.fetch.mockImplementation(async (request) => {
      if (new URL(request.url).pathname === "/api/runs") return Response.json({ approvalId: "pending" });
      resolves += 1;
      return resolves === 1 ? new Response(null, { status }) : Response.json({ ok: true });
    });
    expect(await h.instance.tick(h.orchestrator, NOW)).toEqual({ fired: 0 });
    expect(h.storage.data.has(BATCH_KEY)).toBe(true);
    expect((await h.storage.get<AutomationsState>("state"))!.items[0]!.runCount).toBe(1);
    expect(await h.recreate().tick(h.orchestrator, NOW + 300_000)).toEqual({ fired: 1 });
    expect(h.fetch.mock.calls.filter(([request]) => new URL(request.url).pathname === "/api/runs")).toHaveLength(1);
    expect(resolves).toBe(2);
    expect((await h.storage.get<AutomationsState>("state"))!.items[0]!.runCount).toBe(1);
    expect(h.storage.data.has(BATCH_KEY)).toBe(false);
    expect(h.storage.data.has("webhook-queue-intent:batched")).toBe(false);
  });

  it("does not upgrade a previously queued no-PR task to unattended execution after config changes", async () => {
    const h = fixture({ unattended: true, unattendedRepos: ["owner/repo"], dailyRunLimit: 1 }); h.due();
    h.storage.failBatchDelete = true;
    await expect(h.instance.tick(h.orchestrator, NOW)).rejects.toMatchObject({ message: "storage acknowledgement interrupted" });
    h.env.GITHUB_TOKEN = "test-only-github-token";
    await h.recreate().tick(h.orchestrator, NOW + 300_000);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(new URL(h.fetch.mock.calls[0]![0].url).pathname).toBe("/api/runs");
    expect(h.storage.data.has(BATCH_KEY)).toBe(false);
  });

  it("retains an uncertain queue outcome while current policy pauses recovery", async () => {
    const h = fixture(); h.due();
    h.fetch.mockRejectedValueOnce(new Error("response lost"));
    await h.instance.tick(h.orchestrator, NOW);
    const paused = (await h.storage.get<AutomationsState>("state"))!;
    paused.items[0] = { ...paused.items[0]!, enabled: false };
    await h.storage.put("state", paused);
    await h.recreate().tick(h.orchestrator, NOW + 300_000);
    expect(h.storage.data.has(BATCH_KEY)).toBe(true);
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it("consumes a deliberate policy skip without queue retries", async () => {
    const h = fixture({ enabled: false }); h.due();
    await h.instance.tick(h.orchestrator, NOW);
    expect(h.storage.data.has(BATCH_KEY)).toBe(false);
    expect(h.fetch).not.toHaveBeenCalled();
    expect((await h.storage.get<AutomationsState>("state"))!.items[0]!.lastSkip?.reason).toContain("disabled");
  });

  it("rejects new bodies while the accepted batch is frozen for a queue attempt", async () => {
    const h = fixture(); h.due();
    let release!: (response: Response) => void;
    h.fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
    const tick = h.instance.tick(h.orchestrator, NOW);
    await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(1));
    expect(await h.recreate().tick(h.orchestrator, NOW + 1)).toEqual({ fired: 0 });
    expect(h.fetch).toHaveBeenCalledTimes(1);
    const extra = await h.webhook("must not merge into an in-flight command");
    expect(extra.status).toBe(503);
    expect(extra.headers.get("retry-after")).toBeTruthy();
    release(Response.json({ approvalId: "pending" }));
    await tick;
    expect(h.storage.data.has(BATCH_KEY)).toBe(false);
  });

  it("gives separate identical-payload batches distinct queue identities", async () => {
    const h = fixture();
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    await h.webhook("same payload");
    await h.instance.tick(h.orchestrator, NOW + 11_000);
    await h.webhook("same payload");
    await h.instance.tick(h.orchestrator, NOW + 11_000);
    const first = await h.fetch.mock.calls[0]![0].clone().json() as { commandId: string };
    const second = await h.fetch.mock.calls[1]![0].clone().json() as { commandId: string };
    expect(first.commandId).not.toBe(second.commandId);
  });

  it("applies count backpressure before accepting more than 32 bodies", async () => {
    const h = fixture();
    for (let i = 0; i < 32; i++) expect((await h.webhook(String(i))).status).toBe(200);
    const excess = await h.webhook("overflow");
    expect(excess.status).toBe(429);
    expect(excess.headers.get("retry-after")).toBeTruthy();
    expect((await h.storage.get<{ bodies: string[] }>(BATCH_KEY))!.bodies).toHaveLength(32);
  });

  it("rejects oversized UTF-8 bodies rather than silently truncating accepted input", async () => {
    const h = fixture();
    expect((await h.webhook("é".repeat(16_001))).status).toBe(413);
    expect(h.storage.data.has(BATCH_KEY)).toBe(false);
  });

  it("bounds the serialized batch, including JSON escape overhead", async () => {
    const h = fixture();
    const body = "\u0000".repeat(10_000);
    expect((await h.webhook(body)).status).toBe(200);
    expect((await h.webhook(body)).status).toBe(429);
    expect((await h.storage.get<{ bodies: string[] }>(BATCH_KEY))!.bodies).toHaveLength(1);
  });

  it("keeps a large frozen intent within per-record storage limits without duplicating payload bodies", async () => {
    const h = fixture({ prompt: "p".repeat(20_000) });
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    for (let i = 0; i < 3; i++) expect((await h.webhook("x".repeat(30_000))).status).toBe(200);
    h.fetch.mockImplementation(async () => {
      const intent = await h.storage.get<{ prompt: string; task?: unknown }>("webhook-queue-intent:batched");
      expect(intent?.prompt).toHaveLength(20_000);
      expect(intent?.task).toBeUndefined();
      expect((await h.storage.get<{ bodies: string[] }>(BATCH_KEY))?.bodies).toHaveLength(3);
      return Response.json({ approvalId: "pending" });
    });
    expect(await h.instance.tick(h.orchestrator, NOW + 11_000)).toEqual({ fired: 1 });
    expect(h.storage.data.has(BATCH_KEY)).toBe(false);
    expect(h.storage.data.has("webhook-queue-intent:batched")).toBe(false);
  });
});
