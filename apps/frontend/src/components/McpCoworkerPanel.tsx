import { type JSX, useMemo } from "react";

function workerHostFromWindow(): string {
  if (typeof window === "undefined") return "<worker-host>";
  const { hostname, host } = window.location;
  if (hostname === "localhost" || hostname === "127.0.0.1") return "<worker-host>";
  return host;
}

const RUN_TOOLS = ["queue_run", "run_status", "list_runs", "list_approvals"] as const;

export function McpCoworkerPanel({
  onOpenAgents,
}: {
  onOpenAgents?: () => void;
}): JSX.Element {
  const host = workerHostFromWindow();
  const origin = typeof window !== "undefined" ? window.location.origin : "https://app.tryshiba.dev";
  const mintCommand = useMemo(
    () =>
      `node scripts/mint-token.mjs --agent coworker --scopes sandbox:exec,runs:read --ttl-days 30 --host ${host} --namespace-id <agentTokensNamespace> --write`,
    [host],
  );
  const mcpUrl = `${origin}/mcp`;

  return (
    <section
      data-testid="mcp-coworker-panel"
      className="rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] p-4 shadow-[var(--sh-card)]"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">
            MCP coworker
          </p>
          <h3 className="text-sm font-semibold text-[var(--fg)]">Queue runs from an external MCP client</h3>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-[var(--muted-foreground-2)]">
            Mint an <code className="font-mono">shb_</code> bearer for a dedicated principal, register{" "}
            <code className="font-mono">{mcpUrl}</code> on the agent, then call{" "}
            {RUN_TOOLS.map((tool, index) => (
              <span key={tool}>
                <code className="font-mono">{tool}</code>
                {index < RUN_TOOLS.length - 1 ? ", " : ""}
              </span>
            ))}
            . There is no approve tool — humans approve in the dashboard or Slack.
          </p>
        </div>
        {onOpenAgents ? (
          <button
            type="button"
            onClick={onOpenAgents}
            className="shrink-0 self-start rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--bg)] px-2.5 py-1 text-[11px] font-mono font-medium text-[var(--primary)] hover:border-[var(--primary)]/40"
          >
            Open Agents & MCP →
          </button>
        ) : null}
      </div>
      <div className="mt-3 space-y-2">
        <p className="text-[11px] font-mono text-[var(--muted-foreground-2)]">Mint token (repo root, correct CF account / KV namespace):</p>
        <pre className="overflow-x-auto rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--bg)] p-3 text-[11px] font-mono leading-relaxed text-[var(--fg)]">
          {mintCommand}
        </pre>
        <p className="text-[11px] text-[var(--muted-foreground-2)]">
          Connector URL: <code className="font-mono">{mcpUrl}</code> with header{" "}
          <code className="font-mono">Authorization: Bearer shb_…</code>. Wrong or expired tokens return plain{" "}
          <code className="font-mono">401</code> before any MCP traffic.{" "}
          <a href="/docs/mcp/" className="text-[var(--primary)] hover:underline">
            Pairing guide
          </a>
        </p>
      </div>
    </section>
  );
}
