/**
 * Acknowledge Linear agent sessions with a thought activity when an API token is configured.
 * Never posts to Linear when credentials are absent (mock / NOT VERIFIED path).
 */
import type { Env } from "../env.js";
import type { LinearAgentSessionEvent } from "./webhook.js";

const GRAPHQL_URL = "https://api.linear.app/graphql";

export async function acknowledgeLinearSession(
  env: Env,
  sessionId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; skipped?: string }> {
  const token = env.LINEAR_API_KEY?.trim() ?? env.LINEAR_OAUTH_ACCESS_TOKEN?.trim();
  if (!token) {
    return { ok: false, skipped: "Linear API token not configured." };
  }
  const mutation = `mutation($input: AgentActivityCreateInput!) {
    agentActivityCreate(input: $input) { success }
  }`;
  const response = await fetchImpl(GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({
      query: mutation,
      variables: {
        input: {
          agentSessionId: sessionId,
          content: { type: "thought", body: "Shiba received the session and queued work for approval." },
        },
      },
    }),
  });
  if (!response.ok) {
    return { ok: false, skipped: `Linear GraphQL HTTP ${response.status}` };
  }
  const json = (await response.json().catch(() => ({}))) as { data?: { agentActivityCreate?: { success?: boolean } } };
  if (json.data?.agentActivityCreate?.success !== true) {
    return { ok: false, skipped: "Linear agentActivityCreate did not succeed." };
  }
  return { ok: true };
}

export function shouldQueueLinearSession(event: LinearAgentSessionEvent): boolean {
  return event.action === "created" || event.action === "prompted";
}

export function linearSessionId(event: LinearAgentSessionEvent): string | null {
  const id = event.agentSession?.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}
