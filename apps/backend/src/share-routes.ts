import { governanceResourceKindSchema } from "@shiba/shared";
import type { Env } from "./env.js";
import { GovernanceError } from "./governance/governance-store.js";
import { createShareLink, resolveShareLinkByToken } from "./governance/share-links-store.js";
import { isAuthorizedRequest, requireJsonContentType, resolveUserId } from "./request-auth.js";
import { normalizeTeamWorkspaceEmail } from "./team-workspaces-store.js";

const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "Cache-Control": "no-store" } });

export async function handleShare(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;

  const publicChat = path.match(/^\/share\/c\/([^/]+)$/);
  const publicFile = path.match(/^\/share\/f\/([^/]+)$/);
  const apiFile = path.match(/^\/api\/share\/file\/([^/]+)$/);

  if ((publicChat || publicFile || apiFile) && request.method === "GET") {
    const token = (publicChat?.[1] ?? publicFile?.[1] ?? apiFile?.[1])!;
    const row = await resolveShareLinkByToken(env, token);
    if (!row) return json({ error: "Share link not found." }, 404);
    if (publicFile || apiFile) {
      if (row.resourceKind !== "file") return json({ error: "Share link not found." }, 404);
      const bucket = env.FILES ?? env.ARTIFACTS;
      if (!bucket) return json({ error: "File storage unavailable." }, 503);
      const object = await bucket.get(`files/${row.workspaceId}/${row.resourceId}`);
      if (!object) return json({ error: "Share link not found." }, 404);
      const headers = new Headers();
      headers.set("Content-Type", object.httpMetadata?.contentType ?? "application/octet-stream");
      headers.set("Cache-Control", "private, max-age=60");
      headers.set("Content-Disposition", "inline");
      return new Response(object.body, { status: 200, headers });
    }
    return json({
      kind: row.resourceKind,
      resourceId: row.resourceId,
      workspaceId: row.workspaceId,
      readOnly: true,
    });
  }

  if (path !== "/api/share") return null;
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
  if (!(await isAuthorizedRequest(request, env)))
    return json({ error: "Authentication required." }, 401);
  const contentError = requireJsonContentType(request);
  if (contentError) return contentError;
  const identity = await resolveUserId(request, env);
  if (!identity) return json({ error: "Authentication required." }, 401);
  let user: string;
  try {
    user = normalizeTeamWorkspaceEmail(identity);
  } catch {
    return json({ error: "Verified email required." }, 403);
  }
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new GovernanceError("JSON body required.");
    body = parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof GovernanceError) return json({ error: error.message }, error.status);
    return json({ error: "Invalid JSON." }, 400);
  }
  const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : "";
  const resourceId = typeof body.resourceId === "string" ? body.resourceId : "";
  const kindParsed = governanceResourceKindSchema.safeParse(body.resourceKind);
  if (!/^ws_[a-f0-9]{24}$/.test(workspaceId) || !kindParsed.success || !resourceId) {
    return json({ error: "Invalid share request." }, 400);
  }
  try {
    const minted = await createShareLink(env, workspaceId, user, {
      resourceKind: kindParsed.data,
      resourceId,
      ttlSeconds: typeof body.ttlSeconds === "number" ? body.ttlSeconds : undefined,
    });
    return json(
      {
        linkId: minted.summary.linkId,
        url: `${url.origin}${minted.urlPath}`,
        expiresAt: minted.summary.expiresAt,
      },
      201,
    );
  } catch (error) {
    if (error instanceof GovernanceError) return json({ error: error.message }, error.status);
    throw error;
  }
}
