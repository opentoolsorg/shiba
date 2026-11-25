import { CURATED_MCP_VENDORS } from "@shiba/shared";
import type { JSX } from "react";

const METHOD_LABEL = { oauth: "OAuth sign-in", bearer: "Bearer token" } as const;
const link = "text-[var(--primary)] underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary)]";

/** Read-only view of the curated MCP presets (the data behind /api/v1/extensions/mcp/directory). */
export function McpServerList({ personalScope = true }: { personalScope?: boolean } = {}): JSX.Element {
  return <section aria-label="MCP servers" className="mt-5">
    <p className="text-sm text-[var(--muted-foreground-2)]">{CURATED_MCP_VENDORS.length} vendor-documented remote MCP presets. A listing is not a live compatibility check, and nothing here connects a server. Connections are set up separately in Extensions.</p>
    <ul className="mt-3 divide-y divide-[var(--border-1)] rounded-2xl border border-[var(--border-1)]">
      {CURATED_MCP_VENDORS.map((vendor) => <li key={vendor.catalogId} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2">
        <div className="min-w-0"><h3 className="text-sm font-semibold">{vendor.name}</h3><p className="text-xs text-[var(--muted-foreground-2)]">Connection methods: {vendor.connectionMethods.map((method) => METHOD_LABEL[method]).join(", ")}</p></div>
        <a href={vendor.docsUrl} target="_blank" rel="noopener noreferrer" className={`inline-flex min-h-11 items-center text-xs ${link}`}>Docs<span className="sr-only"> for {vendor.name} (opens in a new tab)</span></a>
      </li>)}
    </ul>
    <p className="mt-3 text-xs text-[var(--muted-foreground-2)]">Connecting a server does not give any employee access. Grant access separately in {personalScope ? <a href="/employee-tools/" className={link}>Tool policy</a> : "Tool policy, which is available in your personal workspace"}.</p>
  </section>;
}
