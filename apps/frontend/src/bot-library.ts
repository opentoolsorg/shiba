import type { CustomAgentWire } from "./components/CustomAgentsView";
import { teamWorkspaceHeaders } from "./team-workspaces-client";

export const MAX_BOT_DELIVERABLES = 8;

/**
 * A bot's library is its required deliverables: workspace outputs frozen into
 * each approval. Attaching or removing one is a versioned config edit — never a
 * file upload and never a silent change to an approval already in flight.
 */
export async function saveBotDeliverables(
  agent: CustomAgentWire,
  deliverables: readonly string[],
  workspaceId?: string,
): Promise<CustomAgentWire> {
  const cleaned = [...new Set(deliverables.map((value) => value.trim()).filter(Boolean))];
  if (cleaned.length > MAX_BOT_DELIVERABLES) {
    throw new Error(`Use at most ${MAX_BOT_DELIVERABLES} deliverable paths.`);
  }
  const config = { ...agent.config };
  if (cleaned.length) config.expectedDeliverables = cleaned;
  else delete config.expectedDeliverables;
  const response = await fetch(`/api/custom-agents/${encodeURIComponent(agent.id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...teamWorkspaceHeaders(workspaceId) },
    body: JSON.stringify({ config, expectedVersion: agent.version }),
  });
  const body = (await response.json().catch(() => ({}))) as { agent?: CustomAgentWire; error?: string };
  if (response.status === 409) {
    throw new Error("This bot changed since it was opened. Reload the latest version before saving.");
  }
  if (!response.ok || !body.agent) {
    throw new Error(body.error ?? `Could not save the library (${response.status}).`);
  }
  return body.agent;
}
