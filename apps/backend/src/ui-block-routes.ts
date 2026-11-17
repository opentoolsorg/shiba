import type { Env } from "./env.js";
import { isAuthorizedRequest } from "./request-auth.js";
import { resolveRunStoreTarget } from "./runs-routes.js";
import { publishWorkspaceEvent } from "./platform/workspace-events-do.js";
import { answerUiBlock, listUiBlocks, UiBlockError } from "./ui-block-store.js";

export async function handleUiBlocks(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/runs\/([^/]+)\/ui-blocks(?:\/([^/]+)\/answer)?$/);
  if (!match) return null;
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
  if (!(await isAuthorizedRequest(request, env))) return json({ error: "Authentication required." }, 401);
  const resolved = await resolveRunStoreTarget(request, env, url);
  if ("error" in resolved) return resolved.error;
  let runId: string;
  let blockId: string | undefined;
  try { runId = decodeURIComponent(match[1]!); blockId = match[2] ? decodeURIComponent(match[2]) : undefined; }
  catch { return json({ error: "Invalid question path." }, 400); }
  if (request.method !== (blockId ? "POST" : "GET")) return json({ error: "Method not allowed." }, 405);
  if (blockId && request.headers.get("origin") !== url.origin) return json({ error: "Same-origin request required." }, 403);
  try {
    if (!blockId) return json({ ok: true, questions: await listUiBlocks(env, resolved.userId, runId, true) });
    let body: unknown;
    try { body = await request.json(); } catch { return json({ error: "Invalid JSON answer." }, 400); }
    const result = await answerUiBlock(env, resolved.userId, runId, blockId, body, "web");
    const workspaceId = request.headers.get("X-Shiba-Workspace");
    if (workspaceId) {
      await publishWorkspaceEvent(env, workspaceId, { kind: "ui_block.answered", entityId: runId, audience: { userIds: [resolved.userId] }, payload: { blockId } });
    }
    return json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof UiBlockError) return json({ error: error.message, errors: error.errors }, error.status);
    return json({ error: "UI block questions are temporarily unavailable." }, 503);
  }
}
