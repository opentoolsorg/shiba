import { type JSX, useEffect, useRef, useState } from "react";
import { Code, Monitor, Search, Terminal, type LucideIcon } from "lucide-react";
import type { AgentPrincipal } from "../types";
import { formatTimeAgo } from "../ui-helpers";
import { ExternalMcpManagement } from "./ExternalMcpManagement";
import { ViewEmpty, ViewGroup, ViewHeader, viewButtonClass } from "./ui/ViewChrome";

function ClientIcon({ client, fallback: Fallback }: { client: "claude" | "cursor" | "cli"; fallback: LucideIcon }) {
  const [failed, setFailed] = useState(false);
  return client === "cli" || failed ? <Fallback aria-hidden="true" className="size-4" /> : <img src={`/assets/harnesses/${client}.svg`} alt="" className="size-5 rounded bg-white p-0.5" onError={() => setFailed(true)} />;
}
export function AgentsView(): JSX.Element {
  const [principals, setPrincipals] = useState<AgentPrincipal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [clientsError, setClientsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [copiedSnippet, setCopiedSnippet] = useState<string | null>(null);
  const [mcpTab, setMcpTab] = useState<"claude" | "cursor" | "cli">("cli");
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/agents");
        if (!response.ok) throw new Error(`Agents request failed: ${response.status}`);
        const body = (await response.json()) as { principals?: AgentPrincipal[] };
        if (!cancelled) setPrincipals(Array.isArray(body.principals) ? body.principals : []);
      } catch (err) {
        if (!cancelled) setClientsError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    };
  }, []);

  const copyToClipboard = (text: string, label: string) => {
    setError(null);
    setCopiedSnippet(null);
    if (!navigator.clipboard?.writeText) {
      setError("Could not copy. Select and copy the text instead.");
      return;
    }
    void navigator.clipboard.writeText(text).then(() => {
      setCopiedSnippet(label);
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopiedSnippet(null), 2000);
    }).catch(() => setError("Could not copy. Select and copy the text instead."));
  };
  const origin = typeof window !== "undefined" ? window.location.origin : "https://your-worker.workers.dev";
  const mcpEndpoint = `${origin}/mcp`;
  const workerHost = typeof window !== "undefined" && !["localhost", "127.0.0.1"].includes(window.location.hostname) ? window.location.host : "<worker-host>";
  const claudeConfig = JSON.stringify({ mcpServers: { shiba: { url: mcpEndpoint, headers: { Authorization: "Bearer <YOUR_AGENT_TOKEN>" } } } }, null, 2);
  const cursorConfig = ["// In Cursor Settings -> MCP Servers:", "Name: shiba", "Transport: Streamable HTTP", `URL: ${mcpEndpoint}`, "Header: Authorization: Bearer <YOUR_AGENT_TOKEN>"].join("\n");
  const mintCommand = `node scripts/mint-token.mjs --agent scout --scopes email:read --host ${workerHost} --namespace-id <agentTokensNamespace> --write`;
  const mintCoworkerCommand = `node scripts/mint-token.mjs --agent grok-bot --scopes sandbox:exec,runs:read --ttl-days 30 --host ${workerHost} --namespace-id <agentTokensNamespace> --write`;
  const snippet = mcpTab === "claude" ? claudeConfig : mcpTab === "cursor" ? cursorConfig : mintCoworkerCommand;
  const filtered = principals.filter((p) => `${p.principal} ${p.scopes.join(" ")}`.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden bg-[var(--bg)] text-[var(--fg)]">
      <ViewHeader section="Resources" view="MCP gateway" count={loading ? "Loading clients" : clientsError ? "Clients unavailable" : `${principals.length} clients`}>
        <button type="button" aria-label="Search clients" aria-expanded={searchOpen} onClick={() => setSearchOpen(!searchOpen)} className={viewButtonClass}><Search aria-hidden="true" className="size-4" /></button>
        <fieldset aria-label="MCP configuration" className="flex min-w-0 flex-wrap gap-1 rounded-lg bg-[var(--secondary)] p-1">
          {([{ id: "claude", label: "Claude Desktop", icon: Monitor }, { id: "cursor", label: "Cursor", icon: Code }, { id: "cli", label: "Mint token CLI", icon: Terminal }] as const).map(({ id, label, icon: Icon }) => (
            <button key={id} type="button" aria-pressed={mcpTab === id} onClick={() => { setMcpTab(id); setCopiedSnippet(null); }} className={`inline-flex min-h-11 items-center gap-2 rounded-md px-3 text-[13px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)] ${mcpTab === id ? "bg-[var(--card)] text-[var(--fg)] shadow-plate" : "text-[var(--muted-foreground-1)] hover:text-[var(--fg)]"}`}><ClientIcon client={id} fallback={Icon} />{label}</button>
          ))}
        </fieldset>
      </ViewHeader>
      <div className="flex-1 overflow-y-auto p-4 sm:p-6">
        <div className="mx-auto flex max-w-5xl flex-col gap-6">
          <section aria-label="About MCP" className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-xl"><h3 className="text-lg font-medium tracking-tight">Bring Shiba to your tools.</h3><p className="mt-2 text-[13px] leading-relaxed text-[var(--muted-foreground-2)]">Configure an MCP client to use Shiba’s gateway with a scoped agent token. These are technical client credentials, not your reusable employee agents.</p></div>
            <span className="rounded-full border border-[var(--border-1)] bg-[var(--section)] px-3 py-1.5 text-xs text-[var(--muted-foreground-2)]">Connection not verified</span>
          </section>
          {error ? <p role="alert" className="rounded-lg bg-[var(--destructive-soft)] p-3 text-sm text-[var(--fg)]">{error}</p> : null}
          <section aria-label="Gateway configuration" className="min-w-0 rounded-xl border border-[var(--border-1)] bg-[var(--card)] p-4 sm:p-5">
            <div className="flex min-h-11 flex-wrap items-center justify-between gap-3 border-b border-[var(--border-1)] pb-3">
              <div className="min-w-0"><h3 className="text-[13px] font-medium">Gateway endpoint</h3><code className="break-all text-xs text-[var(--muted-foreground-2)]">{mcpEndpoint}</code></div>
              <button type="button" onClick={() => copyToClipboard(mcpEndpoint, "endpoint")} className={viewButtonClass}>{copiedSnippet === "endpoint" ? "Copied" : "Copy URL"}</button>
            </div>
            <p className="py-3 text-xs text-[var(--muted-foreground-2)]">Connect an MCP client to Shiba. Connection is not verified here.</p>
            <div className="mb-3 flex items-center justify-between gap-3"><h3 className="text-[13px] font-medium">{mcpTab === "cli" ? "Mint a token" : "Client configuration"}</h3><button type="button" onClick={() => copyToClipboard(snippet, "snippet")} className={viewButtonClass}>{copiedSnippet === "snippet" ? "Copied" : "Copy configuration"}</button></div>
            <pre className="overflow-x-auto rounded-lg border border-[var(--border-1)] bg-[var(--section)] p-4 font-mono text-xs leading-relaxed text-[var(--fg)]">{snippet}</pre>
            <p className="mt-3 text-xs leading-relaxed text-[var(--muted-foreground-2)]">Replace <code>scout</code> with the principal assigned in Inbox. Use <code>--write</code> to store the token hash in the deployed <code>AGENT_TOKENS</code> namespace. Without it, the token cannot authenticate. Never paste tokens into a mailbox or public log.</p>
            <a href="/docs/mcp/" className="inline-flex min-h-11 items-center rounded text-[13px] text-[var(--fg)] underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-[var(--ring)]">Connection guide</a>
          </section>
          {searchOpen ? <input type="search" aria-label="Filter clients" placeholder="Search clients" value={query} onChange={(e) => setQuery(e.target.value)} className="min-h-11 rounded-lg border border-[var(--border-1)] bg-[var(--input)] px-3 text-sm text-[var(--fg)] placeholder:text-[var(--muted-foreground-2)] focus-visible:outline-2 focus-visible:outline-[var(--ring)]" /> : null}
          <section aria-label="Client registry" className="min-w-0 rounded-xl border border-[var(--border-1)] bg-[var(--card)] p-3">
          <p className="px-3 pb-3 pt-1 text-xs leading-relaxed text-[var(--muted-foreground-2)]">Registered principals and their token scopes. An active token does not confirm that a client is connected.</p>
          <ViewGroup title="Registered MCP clients" count={loading || clientsError ? undefined : filtered.length}>
            {loading ? <p role="status">Loading clients…</p> : clientsError ? <p role="alert">Could not load clients. {clientsError}</p> : filtered.length === 0 ? <><ViewEmpty>{query ? "No matching clients" : "No clients yet"}</ViewEmpty>{query.trim() ? <button type="button" onClick={() => setQuery("")} className={viewButtonClass}>Clear search</button> : <a href="/?tab=inbox" className={`${viewButtonClass} border-dashed`}>Open Inbox setup</a>}</> : (
              <div className="overflow-x-auto"><table className="w-full text-left text-[13px]"><thead className="border-b border-[var(--border-1)] text-xs text-[var(--muted-foreground-2)]"><tr><th className="px-3 py-3 font-medium">Principal</th><th className="px-3 py-3 font-medium">Scopes</th><th className="px-3 py-3 font-medium">Registered</th><th className="px-3 py-3 font-medium">Status</th></tr></thead><tbody>{filtered.map((p) => <tr key={p.principal} className="h-11 border-b border-[var(--border-1)] hover:bg-[var(--card-hover)]"><td className="px-3 py-3">{p.principal}</td><td className="px-3 py-3 font-mono text-xs text-[var(--muted-foreground-2)]">{p.scopes.join(", ")}</td><td className="px-3 py-3 text-xs text-[var(--muted-foreground-2)]">{formatTimeAgo(p.created)}</td><td className="px-3 py-3">{p.live ? "Token active" : "Token revoked"}</td></tr>)}</tbody></table></div>
            )}
          </ViewGroup>
          </section>
          <span role="status" className="sr-only">{copiedSnippet ? "Copied to clipboard" : ""}</span>
        </div>
          <div className="mt-6">
            <ExternalMcpManagement />
          </div>
      </div>
    </div>
  );
}
