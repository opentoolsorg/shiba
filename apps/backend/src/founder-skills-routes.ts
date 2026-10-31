import {
  founderSkillAutomationId,
  getFounderSkillLibraryEntry,
  listFounderSkillLibrary,
} from "@shiba/shared";
import type { Env } from "./env.js";
import { resolveOrgForApiRequest } from "./org-request-auth.js";
import { isAuthorizedRequest, resolveUserId } from "./request-auth.js";
import { requireV1Read, requireV1Write, v1Forbidden } from "./v1-auth.js";
import { hasSameOriginIntent, methodNotAllowed } from "./route-utils.js";
import { createAutomation, type Automation } from "./automations.js";
import { createSkill } from "./skills-store.js";
import { getAgentByName } from "agents/routing";
import { AUTOMATIONS_DO_NAME } from "./automation-runner.js";

import { listGrokbotBridgeTasks, publicBridgeTask } from "./grokbot-bridge-store.js";
import { resolveBridgeApproval } from "./grokbot-bridge-runner.js";

const automationsPath = /^\/api\/founder-skills(?:\/([^/]+)(?:\/(install|deploy))?)?\/?$/;

function buildBridgeAutomation(skillId: string): Automation {
  const entry = getFounderSkillLibraryEntry(skillId);
  if (!entry) throw new Error("not_found");
  return createAutomation({
    id: founderSkillAutomationId(entry.id),
    prompt: entry.automationPrompt,
    executionTarget: {
      kind: "grokbot-bridge",
      founderSkillId: entry.id,
      workspaceName: entry.workspaceName,
      expectedDeliverables: [...entry.expectedDeliverables],
      bridgeCatalogIds: [...entry.bridgeCatalogIds],
      requiresSensitiveApproval: entry.requiresSensitiveApproval,
    },
    triggers: [{ kind: "schedule", cron: entry.schedule.cron, timezone: entry.schedule.timezone }],
    enabled: true,
  }).automation;
}

export async function handleFounderSkills(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/founder-skills")) return null;
  const approvalMatch = url.pathname.match(/^\/api\/founder-skills\/bridge-approvals(?:\/([^/]+))?$/);
  if (approvalMatch) {
    // Connector tokens may submit results, but only a dashboard operator may
    // release a sensitive frozen digest. Dashboard tenancy is self-hosted.
    if (request.headers.has("authorization") || !await isAuthorizedRequest(request, env)) return Response.json({ error: "Dashboard authentication required." }, { status: 401 });
    if (!env.AGENT_AUDIT) return Response.json({ error: "Bridge storage unavailable." }, { status: 503 });
    if (request.method === "GET" && !approvalMatch[1]) {
      const tasks = await listGrokbotBridgeTasks(env, "self-hosted", undefined, "awaiting_approval");
      return Response.json({ approvals: tasks.map((task) => ({ ...publicBridgeTask(task), slackText: task.slackText })) }, { headers: { "cache-control": "no-store" } });
    }
    if (request.method !== "POST" || !approvalMatch[1]) return methodNotAllowed();
    if (!hasSameOriginIntent(request)) return Response.json({ error: "Same-origin request required." }, { status: 403 });
    const body = await request.json().catch(() => null) as { approved?: unknown } | null;
    if (typeof body?.approved !== "boolean") return Response.json({ error: "approved must be boolean." }, { status: 400 });
    try {
      const task = await resolveBridgeApproval(env, "self-hosted", approvalMatch[1], body.approved);
      return Response.json({ task: task ? publicBridgeTask(task) : null });
    } catch {
      return Response.json({ error: "Bridge approval is not pending." }, { status: 409 });
    }
  }
  const match = url.pathname.match(automationsPath);
  if (!match) return Response.json({ ok: false, error: "not_found" }, { status: 404 });

  const auth = await resolveOrgForApiRequest(request, env);
  if (auth instanceof Response) return auth;
  const isRead = request.method === "GET";
  if (auth.principal) {
    if (isRead ? !requireV1Read(auth.principal) : !requireV1Write(auth.principal)) return v1Forbidden();
  }
  const ownerId = auth.principal?.principal ?? await resolveUserId(request, env);
  if (!ownerId) return Response.json({ ok: false, error: "authentication_required" }, { status: 401 });

  const skillId = match[1] ? decodeURIComponent(match[1]) : null;
  const action = match[2];

  if (!skillId && request.method === "GET") {
    return Response.json({
      ok: true,
      skills: listFounderSkillLibrary().map((entry) => ({
        id: entry.id,
        name: entry.name,
        description: entry.description,
        author: entry.author,
        schedule: entry.schedule,
        bridgeCatalogIds: entry.bridgeCatalogIds,
        requiresSensitiveApproval: entry.requiresSensitiveApproval,
      })),
    }, { headers: { "cache-control": "public, max-age=300" } });
  }

  if (!skillId || !getFounderSkillLibraryEntry(skillId)) {
    return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  if (action === "install" && request.method === "POST") {
    if (!env.AGENT_AUDIT) return Response.json({ ok: false, error: "skill_storage_unavailable" }, { status: 503 });
    const entry = getFounderSkillLibraryEntry(skillId)!;
    const skill = await createSkill(env, auth.orgId, ownerId, {
      name: entry.name,
      instructions: entry.instructions,
      sourceUrl: entry.sourceUrl,
    });
    return Response.json({
      ok: true,
      skill: {
        id: skill.id,
        version: skill.version,
        status: skill.status,
        name: skill.content.name,
        libraryId: entry.id,
        note: "Review and activate the draft before pinning it on automations.",
      },
    }, { status: 201 });
  }

  if (action === "deploy" && request.method === "POST") {
    if (!env.CodingOrchestrator) return Response.json({ ok: false, error: "automations_unavailable" }, { status: 503 });
    let automation: Automation;
    try {
      automation = buildBridgeAutomation(skillId);
    } catch {
      return Response.json({ ok: false, error: "not_found" }, { status: 404 });
    }
    const stub = await getAgentByName(env.CodingOrchestrator, AUTOMATIONS_DO_NAME);
    const response = await stub.fetch(new Request("https://internal/api/automations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: automation.id,
        prompt: automation.prompt,
        executionTarget: automation.executionTarget,
        triggers: automation.triggers,
        enabled: automation.enabled,
      }),
    }));
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      return Response.json({
        ok: false,
        error: typeof body === "object" && body && "error" in body ? (body as { error?: string }).error : "deploy_failed",
      }, { status: response.status });
    }
    return Response.json({ ok: true, automation: body, libraryId: skillId }, { status: 201 });
  }

  return methodNotAllowed();
}
