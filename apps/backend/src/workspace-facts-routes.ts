import type { Env } from "./env.js";
import { assertAdminOperator } from "./governance/admin-console.js";
import { GovernanceError } from "./governance/governance-store.js";
import { requireSameOriginBrowserMutation } from "./request-auth.js";
import { WorkspaceChannelFactsStore } from "./workspace-channel-facts.js";

const PREFIX = "/api/admin/workspace-facts";
const json = (body: unknown, status = 200) => Response.json(body, {
  status, headers: { "Cache-Control": "no-store" },
});

export async function handleWorkspaceFacts(request: Request, env: Env): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) return null;
  try {
    await assertAdminOperator(request, env);
    const originError = requireSameOriginBrowserMutation(request);
    if (originError) return originError;
    if (!env.AGENT_AUDIT) return json({ error: "Workspace facts storage is unavailable." }, 503);
    const store = new WorkspaceChannelFactsStore(env.AGENT_AUDIT);
    if (path === PREFIX && request.method === "GET") return json({ facts: await store.listAll() });
    const match = /^\/api\/admin\/workspace-facts\/([^/]+)$/.exec(path);
    if (match?.[1] && request.method === "DELETE") {
      let id: string;
      try { id = decodeURIComponent(match[1]); }
      catch { return json({ error: "Invalid fact id." }, 400); }
      if (!await store.deleteById(id)) return json({ error: "Workspace fact not found." }, 404);
      return json({ deleted: true });
    }
    return json({ error: "Not found." }, 404);
  } catch (error) {
    if (error instanceof GovernanceError) return json({ error: error.message }, error.status);
    throw error;
  }
}
