import { useRef, useState, type JSX } from "react";
import { ChevronRight, Plus, Server } from "lucide-react";
import { CuratedMcpConnections } from "./CuratedMcpConnections";
import { ExternalMcpManagement } from "./ExternalMcpManagement";
import { type Scope } from "./ui/ContextPanel";

export interface ExtensionMcpServersViewProps {
  scope?: Scope;
}

/**
 * ExtensionMcpServersView — MCP hub under More > Extensions.
 * Curated connections and external MCP registry; the host view supplies the card.
 */
export function ExtensionMcpServersView({ scope = "personal" }: ExtensionMcpServersViewProps = {}): JSX.Element {
  const [revision, setRevision] = useState(0);
  const addFormRef = useRef<HTMLDivElement>(null);

  const scopeCrumb = scope === "workspace" ? "Workspace" : "Personal";
  const crumbs = [scopeCrumb, "Extensions", "MCP Servers"];

  const handleAddServer = () => {
    const input = document.getElementById("external-mcp-name") || document.querySelector('input[aria-label="MCP server name"]');
    if (input instanceof HTMLElement) {
      input.focus();
      input.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <header className="flex h-12 min-h-[48px] shrink-0 items-center justify-between border-b border-[#e4e4e7] px-4 select-none dark:border-zinc-800">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 min-w-0">
          <ol className="flex items-center gap-1.5 min-w-0">
            {crumbs.map((crumb, idx) => {
              const isLast = idx === crumbs.length - 1;
              return (
                <li key={`${crumb}-${idx}`} className="flex items-center gap-1.5 min-w-0">
                  {idx > 0 ? (
                    <ChevronRight className="size-3.5 text-[#71717a] shrink-0 dark:text-zinc-500" strokeWidth={1.5} aria-hidden="true" />
                  ) : null}
                  <span
                    className={isLast ? "truncate text-[14px] font-medium text-[#0a0a0a] dark:text-zinc-100" : "truncate text-[14px] text-[#71717a] dark:text-zinc-400"}
                    aria-current={isLast ? "page" : undefined}
                  >
                    {crumb}
                  </span>
                </li>
              );
            })}
          </ol>
        </nav>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={handleAddServer}
            className="inline-flex h-7 items-center gap-1.5 rounded-md bg-[#0a0a0a] px-3 text-xs font-medium text-white shadow-sm hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            <Plus className="size-3.5" /> Add Server
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 lg:px-8">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
          <section className="rounded-xl border border-[#e4e4e7] bg-[#fafafa] p-4 text-xs dark:border-zinc-800 dark:bg-zinc-900/50">
            <div className="flex items-start gap-3">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-zinc-200/70 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                <Server className="size-4" />
              </div>
              <div>
                <h1 className="text-sm font-semibold text-[#0a0a0a] dark:text-zinc-100" aria-label="Custom MCP servers">
                  MCP Servers
                </h1>
                <p className="mt-1 text-xs text-[#71717a] dark:text-zinc-400">
                  Connect an account, discover its tools, review each effect, then enable and grant the exact capabilities you need. Saved credentials and workspace visibility do not grant employee access.
                </p>
                <p className="mt-1 text-[11px] text-[#71717a] dark:text-zinc-500">
                  Only public HTTPS Streamable HTTP is supported. SSE-only servers, stdio commands, custom authentication headers and automatic tool approval are unavailable.
                </p>
              </div>
            </div>
          </section>

          <CuratedMcpConnections onChanged={() => setRevision((value) => value + 1)} />

          <div ref={addFormRef}>
            <ExternalMcpManagement key={revision} />
          </div>
        </div>
      </div>
    </div>
  );
}
