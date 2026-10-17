import { MAX_COMMAND_RECEIPTS, stableHash } from "@shiba/shared";
import { agentCliCatalog } from "../harness/catalog.js";
import { resolveUserId } from "../request-auth.js";
import type { V1Context } from "./context.js";

const OPERATIONS = [
  ["listThreadMessages", "GET", "/threads/{id}/messages"],
  ["exportThreadTranscript", "GET", "/threads/{id}/export"],
  ["listThreadRuns", "GET", "/threads/{id}/runs"],
  ["getThreadRunState", "GET", "/threads/{id}/run-state"],
  ["getActiveRun", "GET", "/threads/{id}/active-run"],
  ["stopRun", "POST", "/threads/{id}/stop"],
  ["retryThread", "POST", "/threads/{id}/retry"],
  ["getRunFailure", "GET", "/threads/{id}/runs/{runId}/failure"],
  ["listRunActivity", "GET", "/threads/{id}/runs/{runId}/activity"],
  ["getRunActivityBounds", "GET", "/threads/{id}/runs/{runId}/activity/bounds"],
  ["listThreadQuestions", "GET", "/threads/{id}/questions"],
  ["getModelProviders", "GET", "/model-providers"],
  ["getCapabilities", "GET", "/capabilities"],
];

export async function handleSystem(ctx: V1Context): Promise<Response | null> {
  const operation = ctx.url.pathname.match(/^\/api\/v1\/operations\/([^/]+)$/);
  if (!operation && !["/api/v1/capabilities", "/api/v1/model-providers"].includes(ctx.url.pathname)) return null;
  if (ctx.request.method !== "GET") return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
  if (operation) {
    try { decodeURIComponent(operation[1]!); }
    catch { return Response.json({ ok: false, error: "invalid_operation" }, { status: 400 }); }
    return Response.json({ ok: false, error: "not_implemented", detail: "Command receipts are not exposed by the orchestrator read API." }, { status: 501 });
  }
  const catalog = agentCliCatalog(ctx.env);
  if (ctx.url.pathname === "/api/v1/capabilities") {
    return Response.json({ ok: true, principalId: (await resolveUserId(ctx.request, ctx.env)) ?? "default",
      orgId: "self-hosted", projectIds: null, permissions: null,
      operations: OPERATIONS.map(([operationId, method, path]) => ({ operationId, method, path: `/api/v1${path}`, permissions: [] })),
      availability: { runs: true, models: catalog.length > 0, questions: false, compaction: false,
        fullTranscripts: false, operationReceipts: false, threadMetadata: false },
      // Zero means no time-based retention guarantee; receipts are count-bounded, not seven-day records.
      limits: { eventRetentionDays: 0, idempotencyRetentionDays: 0, credentialLifetimeDays: 0,
        credentialOverlapHours: 0, attachmentMaxBytes: 0, commandReceiptMaxCount: MAX_COMMAND_RECEIPTS } });
  }
  const models = [...new Set(catalog.map((entry) => entry.defaultModel))].map((id) => ({
    id, name: id, provider: id.split("/")[0] ?? "unknown",
  }));
  const providers = ["openai", "anthropic", "google", "xai", "deepseek", "openrouter"].flatMap((provider) => {
    const model = models.find((entry) => entry.provider === provider);
    return model ? [{ provider, label: provider, defaultModelId: model.id }] : [];
  });
  return Response.json({ ok: true, modelConfigurationRevision: stableHash(models), providers, models,
    runConfig: { defaultModelId: ctx.env.CODING_MODEL || catalog[0]?.defaultModel || "unconfigured",
      defaultReasoning: "off", defaultSpeed: "standard", defaultsVersion: 1, providerMappingsVersion: 1,
      modelFallbackIds: [], reasoningOptions: [], speedOptions: ["standard"] } });
}
