import { describe, expect, it } from "vitest";
import { buildEmployeeDecisionData, parseEmployeeDecisionData } from "@shiba/shared";
import {
  chatEmployeeQueueExtras,
  decideChatEmployeeToolApproval,
  resolveChatEmployeeFromText,
  stripChatEmployeeToken,
} from "../src/chat-employee.js";
import { queueChatRun } from "../src/chat-lane.js";
import { createCustomAgent, updateCustomAgent } from "../src/custom-agents-store.js";
import { replaceEmployeeToolGrants, requestEmployeeActionApproval } from "../src/employee-tool-store.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

describe("stripChatEmployeeToken", () => {
  it("removes bot:slug and returns the remainder", () => {
    expect(stripChatEmployeeToken("bot:marketing-bot draft the campaign")).toEqual({
      slug: "marketing-bot",
      remainder: "draft the campaign",
    });
  });
});

describe("resolveChatEmployeeFromText", () => {
  it("returns none when no token and no default", async () => {
    const { database } = customAgentD1();
    const result = await resolveChatEmployeeFromText({ AGENT_AUDIT: database }, "fix login");
    expect(result).toEqual({ kind: "none", taskText: "fix login" });
  });

  it("resolves a saved profile by slug", async () => {
    const { database } = customAgentD1();
    const env = { AGENT_AUDIT: database } as const;
    const agent = await createCustomAgent(env, "self-hosted", "research-bot", {
      name: "Research bot",
      instructions: "Research only.",
      harness: "opencode",
      defaultRepoUrl: "https://github.com/example/research",
    });
    const result = await resolveChatEmployeeFromText(env, `employee:${agent.slug} summarize findings`);
    expect(result).toMatchObject({
      kind: "ok",
      taskText: "summarize findings",
      orgId: "self-hosted",
      agent: { id: agent.id, slug: "research-bot" },
    });
  });
});

describe("chatEmployeeQueueExtras", () => {
  it("builds artifact-workspace queue fields when the profile has deliverables and no repo", async () => {
    const { database } = customAgentD1();
    const env = { AGENT_AUDIT: database } as const;
    const agent = await createCustomAgent(env, "self-hosted", "marketing-bot", {
      name: "Marketing bot",
      instructions: "Draft marketing assets.",
      harness: "opencode",
      expectedDeliverables: ["marketing/brief.md"],
    });
    const built = await chatEmployeeQueueExtras(env, agent, "self-hosted", "Write the launch brief", null);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.extras.executionTarget).toMatchObject({
      kind: "artifact-workspace",
      expectedDeliverables: ["marketing/brief.md"],
    });
    expect(built.extras.publishPullRequest).toBe(false);
    expect(built.task).toContain("Draft marketing assets.");
  });

  it("requires managed grants before queueing a policy-backed profile", async () => {
    const { database } = customAgentD1();
    const env = { AGENT_AUDIT: database } as const;
    const agent = await createCustomAgent(env, "self-hosted", "ops-bot", {
      name: "Ops bot",
      instructions: "Ops work.",
      harness: "opencode",
      toolScopes: ["mcp:shiba:run_status"],
    });
    const built = await chatEmployeeQueueExtras(
      env,
      agent,
      "self-hosted",
      "Check run",
      "https://github.com/example/repo",
    );
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toMatch(/tool policy/i);
  });
});

describe("queueChatRun employee wiring", () => {
  it("posts customAgentId and orgId to the orchestrator", async () => {
    const requests: Record<string, unknown>[] = [];
    const resolve = async () => ({
      fetch: async (request: Request) => {
        requests.push((await request.json()) as Record<string, unknown>);
        return Response.json({ approvalId: "appr-chat-employee" });
      },
    });
    const result = await queueChatRun(
      {} as never,
      {
        platform: "discord",
        threadKey: "discord:42",
        repoUrl: "https://github.com/example/repo",
        task: "Ship it",
        userId: "u1",
        orgId: "self-hosted",
        customAgentId: "cag-1",
        customAgentVersion: 2,
        employeeToolPolicyVersion: 2,
      },
      resolve,
    );
    expect(result).toMatchObject({ approvalId: "appr-chat-employee" });
    expect(requests[0]).toMatchObject({
      customAgentId: "cag-1",
      customAgentVersion: 2,
      employeeToolPolicyVersion: 2,
      orgId: "self-hosted",
      source: "discord",
    });
  });
});

describe("employee decision pointers", () => {
  it("round-trips emp-approve ids", () => {
    const id = "a1b2c3d4-e5f6-47a8-b9c0-d1e2f3a4b5c6";
    expect(parseEmployeeDecisionData(buildEmployeeDecisionData(true, id))).toEqual({
      approved: true,
      approvalId: id,
    });
  });
});

describe("decideChatEmployeeToolApproval", () => {
  it("records approve/reject for chat ingress", async () => {
    const { database } = customAgentD1();
    const env = { AGENT_AUDIT: database } as const;
    const agent = await createCustomAgent(env, "self-hosted", "writer", {
      name: "Writer",
      instructions: "Write.",
      harness: "opencode",
    });
    const pending = await requestEmployeeActionApproval(env, {
      orgId: "self-hosted",
      employeeId: agent.id,
      employeeVersion: agent.version,
      actorId: "owner@example.test",
      connectionId: "conn-1",
      connectionGeneration: 1,
      capability: { kind: "mcp", id: "mcp:shiba:send_email" },
      action: "send_email",
      resourceId: "outbox",
      argumentDigest: "abc",
      payload: { mailbox: "outbox", subject: "Hi", body: "Draft" },
      policyVersion: "employee-policy-current",
      expiresAt: Date.now() + 60_000,
      executionContextId: "slack:T1:C1:1758217392.000100",
    });
    const approved = await decideChatEmployeeToolApproval(env as import("../src/env.js").Env, {
      orgId: "self-hosted",
      approvalId: pending.approvalId,
      approved: true,
      decidedBy: "slack:U1",
    });
    expect(approved).toEqual({ ok: true, status: "approved" });
  });
});
