import { useState, type JSX } from "react";
import { CuratedMcpConnections } from "./CuratedMcpConnections";
import { ExternalMcpManagement } from "./ExternalMcpManagement";

/** Extensions uses the same owner-scoped registry and reviewed runtime as the MCP gateway. */
export function ExtensionMcpServersView(): JSX.Element {
  const [revision, setRevision] = useState(0);
  return <div className="flex min-w-0 flex-col gap-5 p-4 sm:p-6">
    <header><h1 className="font-serif text-2xl text-[var(--fg)]">Custom MCP servers</h1>
      <p className="mt-2 max-w-3xl text-sm text-[var(--muted-foreground-2)]">Connect an account, discover its tools, review each effect, then enable and grant the exact capabilities you need. Saved credentials and workspace visibility do not grant employee access.</p>
      <p className="mt-2 text-xs text-[var(--muted-foreground-2)]">Only public HTTPS Streamable HTTP is supported. SSE-only servers, stdio commands, custom authentication headers and automatic tool approval are unavailable.</p>
    </header>
    <CuratedMcpConnections onChanged={() => setRevision((value) => value + 1)} />
    <ExternalMcpManagement key={revision} />
  </div>;
}
