import { z } from "zod";
import { EmployeeBundleSchema, MAX_EMPLOYEE_BUNDLE_BYTES } from "@shiba/shared";
import type { Env } from "./env.js";
import { rejectCrossOriginMutation, rejectNonJsonMutation } from "./dashboard-mutation.js";
import { resolveOrgForApiRequest } from "./org-request-auth.js";
import { resolveUserId } from "./request-auth.js";
import { HARNESSES } from "./harness/index.js";
import {
  EmployeeBundleError, exportEmployeeBundle, importEmployeeBundle, previewEmployeeBundle,
} from "./employee-bundles-store.js";

const ExportSchema = z.object({
  employeeId: z.string().min(1).max(100), expectedVersion: z.number().int().positive(),
  skillPins: z.array(z.object({ skillId: z.string().min(1).max(100), version: z.number().int().positive() }).strict()).max(5).default([]),
  requirements: EmployeeBundleSchema.shape.requirements.optional(),
  routines: EmployeeBundleSchema.shape.routines.optional(),
}).strict();
const ImportSchema = z.object({
  previewId: z.string().regex(/^ebp-[a-f0-9]{32}$/),
  expectedDigest: z.string().regex(/^[a-f0-9]{64}$/),
  importId: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/),
  recipe: z.unknown(), reviewed: z.literal(true),
}).strict();

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

async function boundedJson(request: Request): Promise<unknown> {
  if (!request.body) throw new EmployeeBundleError("invalid_json");
  const reader = request.body.getReader();
  // Permit the bounded JSON envelope around a recipe whose own UTF-8 limit is 200KB.
  const bytes = new Uint8Array(MAX_EMPLOYEE_BUNDLE_BYTES + 4096);
  let used = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      if (used + part.value.byteLength > bytes.length) throw new EmployeeBundleError("bundle_too_large", 413);
      bytes.set(part.value, used);
      used += part.value.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used)));
  } finally { await reader.cancel().catch(() => undefined); }
}

/** Dashboard-human only. This endpoint is never registered as an employee/model tool. */
export async function handleEmployeeBundles(request: Request, env: Env): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/api/employee-bundles")) return null;
  if (!/^\/api\/employee-bundles\/(export|preview|import)$/.test(path)) return json({ error: "not_found" }, 404);
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const auth = await resolveOrgForApiRequest(request, env);
  if (auth instanceof Response) return auth;
  if (auth.principal) return json({ error: "human_session_required" }, 403);
  const originBlock = rejectCrossOriginMutation(request) ?? rejectNonJsonMutation(request);
  if (originBlock) return originBlock;
  const ownerId = await resolveUserId(request, env);
  if (!ownerId || /^(?:default|system|automation|agent|mcp|child|subagent)(?::|$)/i.test(ownerId))
    return json({ error: "human_session_required" }, 403);
  if (!env.AGENT_AUDIT) return json({ error: "bundle_storage_unavailable" }, 503);
  try {
    const body = await boundedJson(request);
    if (path.endsWith("/export")) {
      const input = ExportSchema.parse(body);
      return json({ ok: true, recipe: await exportEmployeeBundle(env, auth.orgId, ownerId, input) });
    }
    if (path.endsWith("/preview")) {
      const input = z.object({ recipe: z.unknown() }).strict().parse(body);
      const preview = await previewEmployeeBundle(env, auth.orgId, ownerId, input.recipe);
      return json({ ok: true, ...preview });
    }
    const input = ImportSchema.parse(body);
    const parsed = EmployeeBundleSchema.parse(input.recipe);
    if (!Object.hasOwn(HARNESSES, parsed.profile.harness)) return json({ error: "unsupported_harness" }, 400);
    const result = await importEmployeeBundle(env, auth.orgId, ownerId, input);
    return json({ ok: true, ...result }, 201);
  } catch (error) {
    if (error instanceof EmployeeBundleError) return json({ error: error.message }, error.status);
    if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof TypeError)
      return json({ error: "invalid_bundle" }, 400);
    if (error instanceof Error && /credential-shaped|too large|control characters/.test(error.message))
      return json({ error: error.message }, 400);
    // Storage errors are retryable with the same import id; never expose SQL or private recipe content.
    return json({ error: "bundle_storage_failed_retry_same_import" }, 503);
  }
}
