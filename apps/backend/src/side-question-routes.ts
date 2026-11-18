import { getAgentByName } from "agents/routing";
import type { Env } from "./env.js";
import { getCustomAgentById } from "./custom-agents-store.js";
import { DASHBOARD_ORG_ID } from "./org-request-auth.js";
import { isAuthorizedRequest, resolveUserId } from "./request-auth.js";
import { isRestrictedTeamMember } from "./team-member-auth.js";
import { buildSessionAgentName, isValidSessionId } from "./web-sessions.js";
import { sideQuestionSchema } from "./side-question.js";

export async function handleSideQuestion(request: Request, env: Env): Promise<Response | null> {
  const match = new URL(request.url).pathname.match(/^\/api\/employees\/([^/]+)\/side-question$/);
  if (!match) return null;
  if (!(await isAuthorizedRequest(request, env))) return Response.json({ error: "Authentication required." }, { status: 401 });
  if (request.headers.has("authorization") || request.headers.has("X-Shiba-Workspace") ||
    (env.BETTER_AUTH_SECRET && await isRestrictedTeamMember(request, env))) {
    return Response.json({ error: "Use a private employee thread with your human session." }, { status: 403 });
  }
  if (request.method !== "POST") return Response.json({ error: "Method not allowed." }, { status: 405 });
  const parsed = sideQuestionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || !isValidSessionId(parsed.data.threadId) || parsed.data.threadId === "default") {
    return Response.json({ error: "Provide a threadId, a question of 1–4000 characters, and at most 20 earlier question/answer pairs." }, { status: 400 });
  }
  const userId = (await resolveUserId(request, env)) ?? "default";
  const owner = await getAgentByName(env.CodingOrchestrator, userId);
  const check = await owner.fetch(`https://internal/internal/web-sessions/${encodeURIComponent(parsed.data.threadId)}`);
  const body = check.ok ? await check.json() as { session?: { id: string; userId: string; metadata?: Record<string, unknown> } } : null;
  const session = body?.session;
  let employeeId: string;
  try { employeeId = decodeURIComponent(match[1]!); } catch { return Response.json({ error: "Invalid employee id." }, { status: 400 }); }
  if (!session || session.id !== parsed.data.threadId || session.userId !== userId || session.metadata?.customAgentId !== employeeId ||
    (typeof session.metadata?.orgId === "string" && session.metadata.orgId.startsWith("team:")) ||
    Object.hasOwn(session.metadata ?? {}, "teamWorkspaceId") || Object.hasOwn(session.metadata ?? {}, "teamMembershipVersion")) {
    return Response.json({ error: "Employee thread not found." }, { status: 404 });
  }
  const employee = await getCustomAgentById(env, DASHBOARD_ORG_ID, employeeId, {});
  if (!employee) return Response.json({ error: "Employee not found." }, { status: 404 });
  const thread = await getAgentByName(env.CodingOrchestrator, buildSessionAgentName(userId, parsed.data.threadId));
  return thread.fetch(new Request("https://internal/internal/side-question", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...parsed.data, instructions: employee.config.instructions ?? "" }) }));
}
