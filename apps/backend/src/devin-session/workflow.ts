/**
 * Devin API v3 session workflow — create a session for a task, poll until
 * finished, and surface a PR link or diff text from session messages.
 */
export interface DevinSessionWorkflowOptions {
  apiKey: string;
  orgId: string;
  prompt: string;
  repoUrl?: string;
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
  maxPolls?: number;
}

export interface DevinSessionWorkflowResult {
  sessionId: string;
  sessionUrl: string;
  status: string;
  pullRequestUrl?: string;
  diffText?: string;
}

const TERMINAL = new Set(["completed", "finished", "failed", "cancelled", "error"]);

function authHeaders(apiKey: string): HeadersInit {
  return { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };
}

export async function runDevinSessionWorkflow(opts: DevinSessionWorkflowOptions): Promise<DevinSessionWorkflowResult> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const base = `https://api.devin.ai/v3/organizations/${encodeURIComponent(opts.orgId)}`;
  const body: Record<string, unknown> = { prompt: opts.prompt, bypass_approval: true };
  if (opts.repoUrl) body.repos = [opts.repoUrl];

  const created = await fetchFn(`${base}/sessions`, {
    method: "POST",
    headers: { ...authHeaders(opts.apiKey), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!created.ok) {
    throw new Error(`Devin session create failed: ${created.status}`);
  }
  const createdJson = (await created.json()) as { session_id?: string; url?: string; status?: string };
  const sessionId = createdJson.session_id;
  if (!sessionId) throw new Error("Devin session response missing session_id.");
  const sessionUrl = typeof createdJson.url === "string" ? createdJson.url : `https://app.devin.ai/sessions/${sessionId}`;

  const interval = opts.pollIntervalMs ?? 2_000;
  const maxPolls = opts.maxPolls ?? 120;
  let status = typeof createdJson.status === "string" ? createdJson.status : "running";

  for (let i = 0; i < maxPolls; i++) {
    if (TERMINAL.has(status.toLowerCase())) break;
    await new Promise((r) => setTimeout(r, interval));
    const detail = await fetchFn(`${base}/sessions/${encodeURIComponent(sessionId)}`, {
      headers: authHeaders(opts.apiKey),
    });
    if (!detail.ok) continue;
    const detailJson = (await detail.json()) as { status?: string };
    if (typeof detailJson.status === "string") status = detailJson.status;
  }

  let pullRequestUrl: string | undefined;
  let diffText: string | undefined;
  const messages = await fetchFn(`${base}/sessions/${encodeURIComponent(sessionId)}/messages`, {
    headers: authHeaders(opts.apiKey),
  });
  if (messages.ok) {
    const payload = (await messages.json()) as { messages?: unknown };
    const text = JSON.stringify(payload.messages ?? payload);
    const pr = text.match(/https:\/\/github\.com\/[^\s"]+\/pull\/\d+/);
    if (pr) pullRequestUrl = pr[0];
    const diffMatch = text.match(/```diff[\s\S]*?```/);
    if (diffMatch) diffText = diffMatch[0].replace(/^```diff\n?/, "").replace(/```$/, "");
  }

  return { sessionId, sessionUrl, status, pullRequestUrl, diffText };
}
