// Run tools for external agents: queue runs for human approval and read run state via the
// same orchestrator routes /api/runs and /api/approvals use. Deliberately no approve tool.
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { orchestratorFor, orchestratorNameFor } from "./platform/do-resolver.js";
import { orgIdForRecord, type TokenRecord } from "./agent-tokens.js";
import {
  AGENT_PRINCIPAL_HEADER,
  listRunsInputSchema,
  queueRunInputSchema,
  runStatusInputSchema,
} from "@shiba/shared";
import type { Env } from "./env.js";
import { signInternalRequest } from "./edge-identity.js";

import type { ToolRegistry } from "./mcp-gateway.js";

const DEFAULT_LIST_LIMIT = 20;

function jsonResult(payload: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
}

async function orchestratorJson(env: Env, path: string, init: RequestInit | undefined, principal: TokenRecord): Promise<Record<string, unknown>> {
  const stub = await orchestratorFor(env, { workspaceId: orgIdForRecord(principal) });
  const request = new Request(`https://internal${path}`, init);
  // Vouched principal: the DO scopes run/approval reads and stamps
  // queuedBy on intakes, so one agent token can never see or cancel
  // another agent's runs.
  request.headers.set(AGENT_PRINCIPAL_HEADER, principal.principal);
  // Edge identity: sign the vouched principal so the DO can verify the
  // Worker minted it (no-op until INTERNAL_SIGNING_KEY is configured).
  await signInternalRequest(request, env);
  const res = await stub.fetch(request);
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(typeof body.error === "string" ? body.error : `orchestrator returned ${res.status}`);
  }
  return body;
}

export function registerRunTools(registry: ToolRegistry, env: Env): void {
  registry.registerTool(
    "queue_run",
    "sandbox:exec",
    async (args, ctx) => {
      const body = await orchestratorJson(env, "/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Fields are picked, never spread: a caller-supplied `kind` would
        // let a sandbox:exec token mint an email approval.
        body: JSON.stringify({
          kind: "run",
          threadKey: orchestratorNameFor(env, { workspaceId: orgIdForRecord(ctx.principal) }),
          repoUrl: args.repoUrl,
          task: args.task,
          baseBranch: args.baseBranch,
          publishPullRequest: args.publishPullRequest,
          computer: args.computer,
          harness: args.harness,
          codingModel: args.codingModel,
          connectionId: args.connectionId,
          testCommand: args.testCommand,
        }),
      }, ctx.principal);
      const approvalId = String(body.approvalId);
      return jsonResult({
        status: "pending_approval",
        approvalId,
        // resolveApproval mints the run as `agent-tool:<approvalId>`.
        runId: `agent-tool:${approvalId}`,
        note: "Nothing runs until a human approves this in the dashboard or Slack. After approval, poll run_status with runId.",
      });
    },
    {
      description:
        "Queue a coding task on a GitHub repo as a pending approval. Never starts a run: a human " +
        "approves it in the dashboard or Slack, then it runs with the requested or default harness and model.",
      inputSchema: queueRunInputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
  );

  registry.registerTool(
    "run_status",
    "runs:read",
    async (args, ctx) =>
      jsonResult(await orchestratorJson(env, `/api/runs/${encodeURIComponent(String(args.runId))}`, undefined, ctx.principal)),
    {
      description: "Fetch one run record (status, result, pull request) by runId.",
      inputSchema: runStatusInputSchema.shape,
      annotations: { readOnlyHint: true },
    },
  );

  registry.registerTool(
    "list_runs",
    "runs:read",
    async (args, ctx) => {
      const limit = typeof args.limit === "number" && args.limit >= 1 ? Math.floor(args.limit) : DEFAULT_LIST_LIMIT;
      // The DO slices newest-first itself — no full-registry fetch.
      const { runs } = await orchestratorJson(env, `/api/runs?limit=${limit}`, undefined, ctx.principal);
      return jsonResult({ runs: Array.isArray(runs) ? runs : [] });
    },
    {
      description: `List run records, newest first (default ${DEFAULT_LIST_LIMIT}).`,
      inputSchema: listRunsInputSchema.shape,
      annotations: { readOnlyHint: true },
    },
  );

  registry.registerTool(
    "list_approvals",
    "runs:read",
    async (_args, ctx) => {
      const { approvals, decided } = await orchestratorJson(env, "/api/approvals", undefined, ctx.principal);
      // Email approvals freeze message bodies — those stay behind email scopes.
      const runsOnly = (list: unknown) =>
        (Array.isArray(list) ? (list as Array<{ kind?: string }>) : []).filter((a) => (a.kind ?? "run") === "run");
      return jsonResult({ approvals: runsOnly(approvals), decided: runsOnly(decided) });
    },
    {
      description: "List pending run approvals plus recently decided ones. Approving is a human act — there is no approve tool.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
  );
}
