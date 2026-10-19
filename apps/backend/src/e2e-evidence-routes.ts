import type { Env } from "./env.js";
import { isAuthorizedRequest } from "./request-auth.js";
import { isValidSandboxId } from "./sandbox-routes.js";
import { e2eManifestKey } from "./browser-e2e/evidence-urls.js";

/**
 * Phase 3: serve browser E2E manifests and frame PNGs from ATTACHMENTS.
 * Same auth gate as preview screenshots — PR links resolve for signed-in viewers.
 */
export async function handleE2eEvidence(request: Request, env: Env): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  const match = /^\/api\/e2e-evidence\/([^/]+)\/(.+)$/.exec(pathname);
  if (!match) return null;
  if (!(await isAuthorizedRequest(request, env))) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }
  if (request.method !== "GET") {
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }
  let sandboxId: string;
  let artifact: string;
  try {
    sandboxId = decodeURIComponent(match[1]!);
    artifact = decodeURIComponent(match[2]!);
  } catch {
    return Response.json({ error: "Invalid path encoding." }, { status: 400 });
  }
  if (!isValidSandboxId(sandboxId)) {
    return Response.json({ error: "Invalid sandbox ID format." }, { status: 400 });
  }
  if (artifact.includes("..") || artifact.includes("/")) {
    return Response.json({ error: "Invalid artifact name." }, { status: 400 });
  }

  const key =
    artifact === "manifest.json"
      ? e2eManifestKey(sandboxId)
      : `e2e/${sandboxId}/frames/${artifact}`;
  const object = await env.ATTACHMENTS.get(key);
  if (!object) {
    return Response.json({ error: "Evidence not found." }, { status: 404 });
  }
  const contentType =
    artifact === "manifest.json" ? "application/json" : artifact.endsWith(".png") ? "image/png" : "application/octet-stream";
  return new Response(object.body, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": artifact === "manifest.json" ? "inline" : "inline",
      "Content-Length": String(object.size),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
