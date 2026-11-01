/**
 * Agents & MCP — the unified MCP gateway (/mcp): endpoint configuration for
 * Claude Desktop, Cursor & custom agents, plus the authorized MCP-token
 * principals & scopes (KV: AGENT_TOKENS). Agent providers, skills, and the
 * sandbox CLI catalog live on the Providers page.
 */
import { type JSX, useEffect, useRef, useState } from "react";
import type { AgentPrincipal } from "../types";
import { formatTimeAgo } from "../ui-helpers";
import { ExternalMcpManagement } from "./ExternalMcpManagement";
export function AgentsView(): JSX.Element {
  const [principals, setPrincipals] = useState<AgentPrincipal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copiedSnippet, setCopiedSnippet] = useState<string | null>(null);
  const [mcpTab, setMcpTab] = useState<"claude" | "cursor" | "cli">("cli");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/agents");
        if (!response.ok) throw new Error(`Agents request failed: ${response.status}`);
        const body = (await response.json()) as { principals?: AgentPrincipal[] };
        if (!cancelled) setPrincipals(Array.isArray(body.principals) ? body.principals : []);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const copyTimerRef = useRef<number | null>(null);
  const copyToClipboard = (text: string, label: string) => {
    void navigator.clipboard.writeText(text);
    setCopiedSnippet(label);
    // A rapid second click restarts the countdown instead of leaving the
    // first timer to clear the new label early.
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => {
      copyTimerRef.current = null;
      setCopiedSnippet(null);
    }, 2000);
  };

  const origin =
    typeof window !== "undefined" ? window.location.origin : "https://your-worker.workers.dev";
  const mcpEndpoint = `${origin}/mcp`;
  const workerHost =
    typeof window !== "undefined" && !["localhost", "127.0.0.1"].includes(window.location.hostname)
      ? window.location.host
      : "<worker-host>";

  const claudeConfig = JSON.stringify(
    {
      mcpServers: {
        shiba: {
          url: mcpEndpoint,
          headers: {
            Authorization: "Bearer <YOUR_AGENT_TOKEN>",
          },
        },
      },
    },
    null,
    2,
  );

  const cursorConfig = [
    "// In Cursor Settings -> MCP Servers:",
    "Name: shiba",
    "Transport: Streamable HTTP",
    `URL: ${mcpEndpoint}`,
    "Header: Authorization: Bearer <YOUR_AGENT_TOKEN>",
  ].join("\n");

  const mintCommand = `node scripts/mint-token.mjs --agent scout --scopes email:read --host ${workerHost} --namespace-id <agentTokensNamespace> --write`;
  const mintCoworkerCommand = `node scripts/mint-token.mjs --agent grok-bot --scopes sandbox:exec,runs:read --ttl-days 30 --host ${workerHost} --namespace-id <agentTokensNamespace> --write`;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-8 space-y-8">
        <div>
          <div className="inline-flex items-center gap-2 px-2.5 py-0.5 rounded-[var(--radius-button)] bg-[var(--primary-soft)] border border-[var(--primary)]/20 text-[10px] font-mono text-[var(--primary)] uppercase tracking-wider mb-2 font-bold">
            Capability Plane · Model Context Protocol
          </div>
          <h2 className="text-xl font-bold text-[var(--fg)]">MCP Gateway</h2>
          <p className="mt-1 text-xs text-[var(--muted-foreground-2)] leading-relaxed max-w-2xl font-mono">
            Connect any AI agent to your account&apos;s unified MCP gateway. Shiba gives external
            agents (Claude Desktop, Cursor, OpenCode, Devin) memory, email, sandboxes, and audit
            logging on your own Cloudflare infrastructure.
          </p>
        </div>

        {error ? (
          <div className="rounded-[var(--radius-button)] border border-[color-mix(in_oklch,var(--destructive)_30%,transparent)] bg-[var(--destructive-soft)] px-4 py-3 text-sm text-[var(--destructive)] font-mono text-xs">
            {error}
          </div>
        ) : null}

        <div className="border border-[var(--border-1)] bg-[var(--card)] p-5 rounded-[var(--radius-button)] shadow-[var(--sh-card)] space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-[var(--border-1)] pb-3">
            <div>
              <span className="text-[10px] font-mono uppercase tracking-wider text-[var(--muted-foreground-2)] font-bold">
                Unified Gateway Endpoint
              </span>
              <div className="flex items-center gap-2 mt-0.5">
                <code className="text-xs font-mono font-bold text-[var(--primary)] bg-[var(--bg)] border border-[var(--border-1)] px-2 py-0.5">
                  {mcpEndpoint}
                </code>
                <button
                  type="button"
                  onClick={() => copyToClipboard(mcpEndpoint, "endpoint")}
                  className="text-[11px] font-mono text-[var(--muted-foreground-2)] hover:text-[var(--fg)] border border-[var(--border-1)] bg-[var(--card)] px-2 py-0.5 transition-colors"
                >
                  {copiedSnippet === "endpoint" ? "Copied ✓" : "Copy URL"}
                </button>
              </div>
            </div>
            <span className="text-[11px] font-mono text-[var(--muted-foreground-2)]">
              MCP endpoint; connection not verified here
            </span>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-1 font-mono text-[11px]">
                <button
                  type="button"
                  onClick={() => setMcpTab("claude")}
                  className={`px-2.5 py-1 border transition-colors ${
                    mcpTab === "claude"
                      ? "border-[var(--primary)] bg-[var(--primary)] text-white font-bold"
                      : "border-[var(--border-1)] bg-[var(--bg)] text-[var(--muted-foreground-2)] hover:text-[var(--fg)]"
                  }`}
                >
                  Claude Desktop
                </button>
                <button
                  type="button"
                  onClick={() => setMcpTab("cursor")}
                  className={`px-2.5 py-1 border transition-colors ${
                    mcpTab === "cursor"
                      ? "border-[var(--primary)] bg-[var(--primary)] text-white font-bold"
                      : "border-[var(--border-1)] bg-[var(--bg)] text-[var(--muted-foreground-2)] hover:text-[var(--fg)]"
                  }`}
                >
                  Cursor
                </button>
                <button
                  type="button"
                  onClick={() => setMcpTab("cli")}
                  className={`px-2.5 py-1 border transition-colors ${
                    mcpTab === "cli"
                      ? "border-[var(--primary)] bg-[var(--primary)] text-white font-bold"
                      : "border-[var(--border-1)] bg-[var(--bg)] text-[var(--muted-foreground-2)] hover:text-[var(--fg)]"
                  }`}
                >
                  Mint Token CLI
                </button>
              </div>

              <button
                type="button"
                onClick={() => {
                  const text =
                    mcpTab === "claude"
                      ? claudeConfig
                      : mcpTab === "cursor"
                        ? cursorConfig
                        : mintCoworkerCommand;
                  copyToClipboard(text, "snippet");
                }}
                className="text-[11px] font-mono text-[var(--primary)] hover:underline"
              >
                {copiedSnippet === "snippet" ? "Copied ✓" : "Copy Configuration"}
              </button>
            </div>

            <pre className="p-3 bg-[#0b0e10] text-[#eef4f2] text-xs font-mono overflow-x-auto border border-white/10 rounded-[var(--radius-button)] leading-relaxed">
              {mcpTab === "claude"
                ? claudeConfig
                : mcpTab === "cursor"
                  ? cursorConfig
                  : mintCoworkerCommand}
            </pre>
            <p className="mt-2 text-[11px] text-[var(--muted-foreground-2)]">
              {mcpTab === "cli" ? (
                <>
                  Coworker default: <code>grok-bot</code> with <code>sandbox:exec,runs:read</code> for{" "}
                  <code>queue_run</code> + polling. For mailbox tools use principal <code>scout</code> and email scopes instead.{" "}
                </>
              ) : null}
              Replace <code>scout</code> or <code>grok-bot</code> with the exact principal you assign in Inbox or audit. Minting without
              --write only prints a token; it cannot authenticate until its hash is stored in the
              deployed AGENT_TOKENS namespace. Never paste the token into a mailbox or a public log.{" "}
              <a href="/docs/mcp/" className="text-[var(--primary)] hover:underline">
                Connection guide
              </a>
            </p>
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-mono font-bold uppercase tracking-wider text-[var(--muted-foreground-2)]">
              Registered MCP clients
            </h3>
            <span className="text-[11px] font-mono text-[var(--muted-foreground-2)]">
              {principals.length} registered principal{principals.length === 1 ? "" : "s"}
            </span>
          </div>

          {principals.length === 0 ? (
            <div className="border border-dashed border-[var(--border-1)] bg-[var(--card)] p-6 text-center rounded-[var(--radius-button)] font-mono">
              <p className="text-xs font-bold text-[var(--fg)] mb-1">
                No agent bearer tokens registered yet
              </p>
              <p className="text-[11px] text-[var(--muted-foreground-2)] max-w-md mx-auto mb-3">
                Mint a token to allow Claude Desktop, Cursor, or your custom background worker to
                access Shiba&apos;s capability plane.
              </p>
              <code className="text-[10px] bg-[var(--bg)] border border-[var(--border-1)] px-2.5 py-1 text-[var(--primary)]">
                {mintCommand}
              </code>
              <div className="mt-3">
                <a href="/?tab=inbox" className="text-[var(--primary)] hover:underline">
                  Open Inbox setup →
                </a>
              </div>
            </div>
          ) : (
            <div className="border border-[var(--border-1)] bg-[var(--card)] rounded-[var(--radius-button)] overflow-x-auto font-mono text-xs">
              <table className="w-full text-left">
                <thead className="bg-[var(--bg)] border-b border-[var(--border-1)] text-[10px] uppercase text-[var(--muted-foreground-2)]">
                  <tr>
                    <th className="p-2.5 font-bold">Principal Name</th>
                    <th className="p-2.5 font-bold">Granted Scopes</th>
                    <th className="p-2.5 font-bold">Registered</th>
                    <th className="p-2.5 font-bold text-right">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border-1)]">
                  {principals.map((p) => (
                    <tr key={p.principal} className="hover:bg-[var(--secondary)] transition-colors">
                      <td className="p-2.5 font-bold text-[var(--fg)] flex items-center gap-2">
                        <span className="size-1.5 rounded-full bg-[var(--primary)]" />
                        <span>{p.principal}</span>
                      </td>
                      <td className="p-2.5">
                        <div className="flex flex-wrap gap-1">
                          {p.scopes.map((s) => (
                            <span
                              key={s}
                              className="px-1.5 py-0.5 bg-[var(--primary-soft)] text-[var(--primary)] text-[10px] border border-[var(--primary)]/20 font-semibold"
                            >
                              {s}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="p-2.5 text-[var(--muted-foreground-2)] text-[11px]">
                        {formatTimeAgo(p.created)}
                      </td>
                      <td className="p-2.5 text-right">
                        {p.live ? (
                          <span className="text-[var(--success)] font-bold text-[10px] bg-[color-mix(in_oklch,var(--success)_12%,transparent)] px-2 py-0.5 border border-[color-mix(in_oklch,var(--success)_30%,transparent)]">
                            Active
                          </span>
                        ) : (
                          <span className="text-[var(--destructive)] font-bold text-[10px] bg-[var(--destructive-soft)] px-2 py-0.5 border border-[color-mix(in_oklch,var(--destructive)_30%,transparent)]">
                            Revoked
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <ExternalMcpManagement />

      </div>
    </div>
  );
}
