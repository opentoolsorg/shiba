import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodingOrchestrator, type OrchestratorState } from "../src/agents/orchestrator.js";
import { runInputHash, type PendingApproval } from "@shiba/shared";
import type { Env } from "../src/env.js";
import { productionEnvStubs, setStateLikeProduction } from "./orchestrator-host.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import { StoredApprovalCard } from "../../frontend/src/components/WorkspacePanel.js";
const mock = vi.hoisted(() => ({ native: true, execute: vi.fn() }));
vi.mock("@shiba/auth/better-auth", async (original) => ({ ...await original<typeof import("@shiba/auth/better-auth")>(),
  resolveBetterAuthSessionAccount: async () => mock.native ? { policy: { accountId: "native-owner", email: "owner@example.test", kind: "bootstrap" }, emailVerified: true } : null,
}));
vi.mock("@cloudflare/think", () => ({ Think: class { getTools() { return {}; } keepAliveWhile<T>(work: () => Promise<T>) { return work(); } async schedule() { return {}; } } }));
vi.mock("agents/agent-tools", () => ({ agentTool: () => ({ execute: mock.execute }) }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
const databases: Array<{ close(): void }> = [];
beforeEach(() => { mock.native = true; mock.execute.mockReset(); });
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const OWNER = "owner@example.test", INPUT = { repoUrl: "https://github.com/fixture/repo", task: "Review my explicit owner task", baseBranch: "main", publishPullRequest: false, sandboxProvider: "cloudflare" };
function fixture() {
  const db = customAgentD1(); databases.push(db.sqlite);
  db.sqlite.exec(readFileSync(new URL("../migrations/0022_run_output_archives.sql", import.meta.url), "utf8"));
  db.sqlite.exec('CREATE TABLE "user"(id TEXT PRIMARY KEY,email TEXT,emailVerified INTEGER);CREATE TABLE shiba_auth_account_policy(account_id TEXT PRIMARY KEY,email TEXT,kind TEXT)');
  db.sqlite.prepare('INSERT INTO "user" VALUES(?,?,1)').run("native-owner", OWNER); db.sqlite.prepare("INSERT INTO shiba_auth_account_policy VALUES(?,?,'bootstrap')").run("native-owner", OWNER);
  const namespace = vi.fn(() => { throw new Error("No sandbox before explicit human approval"); });
  const instance = Object.assign(Object.create(CodingOrchestrator.prototype) as CodingOrchestrator, {
    env: { ...productionEnvStubs(), Sandbox: { get: namespace, idFromName: namespace }, AGENT_AUDIT: db.database } as unknown as Env,
    name: OWNER, messages: [], state: { runs: [] } as OrchestratorState,
    setState(next: OrchestratorState) { setStateLikeProduction(this, next); },
  });
  return { ...db, instance, namespace, async queue(extra: Record<string, unknown> = {}) {
    return instance.onRequest(new Request("https://internal/api/runs", { method: "POST", headers: { "Content-Type": "application/json", "X-Shiba-Intake": "dashboard" }, body: JSON.stringify({ ...INPUT, threadKey: OWNER, ...extra }) }));
  } };
}
describe("native output archive frozen before the actual queue approval", () => {
  it("shows exact policy/native UUID/UTC lease on the human card while execution and storage reservation remain absent", async () => {
    const f = fixture(); expect((await f.queue()).status).toBe(200);
    const approval = f.instance.state.pendingApprovals?.[0]; expect(approval?.outputArchive).toMatchObject({ version: 1, ownerAccountId: "native-owner", maxBytes: 8_388_608, maxEvents: 8192 });
    const markup = renderToStaticMarkup(React.createElement(StoredApprovalCard, { approval: approval!, decided: false, onDecide: () => {} }));
    expect(markup).toContain(new Date(approval!.outputArchive!.expiresAt).toISOString()); expect(markup).toContain("native-owner"); expect(markup).toContain("unacknowledged tail is unknown");
    expect(f.instance.state.runs).toEqual([]); expect(f.namespace).not.toHaveBeenCalled(); expect(mock.execute).not.toHaveBeenCalled();
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM run_output_archive_reservations").get()).toEqual({ n: 0 });
    const frozen = { ...approval!, baseBranch: approval!.baseBranch!, publishPullRequest: false };
    expect(runInputHash(frozen)).not.toBe(runInputHash({ ...frozen, outputArchive: undefined }));
  });
  it("honors an explicit opt-out and rejects a client-authored retention expansion", async () => {
    const opted = fixture(); expect((await opted.queue({ outputArchive: null })).status).toBe(200); expect(opted.instance.state.pendingApprovals?.[0]?.outputArchive).toBeUndefined();
    const forged = fixture(); expect((await forged.queue({ outputArchive: { expiresAt: Date.now() + 99_999_999 } })).status).toBe(400);
    expect(forged.instance.state.pendingApprovals ?? []).toEqual([]); expect(forged.namespace).not.toHaveBeenCalled();
  });
  it("does not infer native archive authority from an Access-only or missing native identity", async () => {
    mock.native = false; const f = fixture(); expect((await f.queue()).status).toBe(200);
    expect(f.instance.state.pendingApprovals?.[0]?.outputArchive).toBeUndefined(); expect(f.namespace).not.toHaveBeenCalled();
  });
  it("keeps the SDK chat gate legacy until its exact server-frozen archive policy can be displayed", async () => {
    const f = fixture(); const tool = f.instance.getTools().delegate_coding_task as unknown as { needsApproval(value: unknown, options: { toolCallId: string }): Promise<boolean> };
    expect(await tool.needsApproval(INPUT, { toolCallId: "chat-no-archive" })).toBe(true);
    const approval = f.instance.state.pendingApprovals?.find((item: PendingApproval) => item.approvalId === "chat-no-archive");
    expect(approval?.outputArchive).toBeUndefined(); expect(mock.execute).not.toHaveBeenCalled(); expect(f.namespace).not.toHaveBeenCalled();
  });
});
