/**
 * A standalone, read-only directory for external capabilities.
 *
 * Catalog metadata is supplied by the caller. The component never starts
 * OAuth, changes credentials, or claims a connection succeeded; actions are
 * explicit callbacks owned by the integrating view.
 */
import { useMemo, useState, type JSX } from "react";
import type { AcpProviderCard } from "@shiba/shared";
import type { SetupStatus } from "../live-status";
import type { SavedSkill } from "../saved";

export type CapabilityKind = "connector" | "mcp" | "skill";
export type CapabilityStatus = "available" | "configured" | "liveVerified" | "unsupported" | "planned";
export type CapabilitySource = SetupStatus | AcpProviderCard | SavedSkill | string;

/** Presentation metadata plus optional evidence from Shiba's existing wire types. */
export interface CapabilityCatalogItem {
  id: string;
  name: string;
  kind: CapabilityKind;
  status: CapabilityStatus;
  summary: string;
  category: string;
  requestedScopes?: readonly string[];
  capabilities: readonly string[];
  /** Skills explain procedures; tools/connectors expose actions or data. */
  description?: string;
  source?: CapabilitySource;
  authNote?: string;
  catalogOnly?: boolean;
  version?: string;
  requiredScope?: string;
  writeEffect?: "read_only" | "may_mutate" | "unknown";
  approval?: string;
  verification?: string;
  schemaVersion?: string;
  inputSchema?: Record<string, unknown>;
}

export interface CapabilityCatalogProps {
  items: readonly CapabilityCatalogItem[];
  selectedId?: string;
  onSelect?: (item: CapabilityCatalogItem) => void;
  onConfigure?: (item: CapabilityCatalogItem) => void;
  onReconnect?: (item: CapabilityCatalogItem) => void;
  onCheckHealth?: (item: CapabilityCatalogItem) => void;
  onConnectMcp?: () => void;
  onViewToolHistory?: () => void;
}

const STATUS_LABEL: Record<CapabilityStatus, string> = {
  available: "Available",
  configured: "Configured",
  liveVerified: "Live verified",
  unsupported: "Unsupported",
  planned: "Planned",
};

function StatusLabel({ status }: { status: CapabilityStatus }): JSX.Element {
  const style: Record<CapabilityStatus, string> = {
    available: "border-[var(--border-1)] bg-[var(--section)] text-[var(--muted-foreground-2)]",
    configured: "border-[var(--warning)]/40 bg-[var(--warning-subtle)] text-[var(--warning-fg)]",
    liveVerified: "border-[var(--success)]/35 bg-[var(--success)]/10 text-[var(--success)]",
    unsupported: "border-[var(--border-1)] bg-[var(--section)] text-[var(--muted-foreground-2)]",
    planned: "border-[var(--info)]/30 bg-[var(--primary-soft)] text-[var(--primary)]",
  };
  return (
    <span className={`inline-flex items-center border px-2 py-0.5 text-[10px] font-mono ${style[status]}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

function kindLabel(kind: CapabilityKind): string {
  if (kind === "mcp") return "MCP server";
  if (kind === "skill") return "Skill";
  return "Connector";
}

export function CapabilityCatalog({
  items,
  selectedId,
  onSelect,
  onConfigure,
  onReconnect,
  onCheckHealth,
  onConnectMcp,
  onViewToolHistory,
}: CapabilityCatalogProps): JSX.Element {
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<"all" | CapabilityKind>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | CapabilityStatus>("all");
  const [internalSelectedId, setInternalSelectedId] = useState<string | null>(null);

  const visibleItems = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return items.filter((item) => {
      if (kindFilter !== "all" && item.kind !== kindFilter) return false;
      if (statusFilter !== "all" && item.status !== statusFilter) return false;
      if (!normalizedQuery) return true;
      return [item.name, item.summary, item.category, item.description ?? "", ...item.capabilities]
        .join(" ")
        .toLocaleLowerCase()
        .includes(normalizedQuery);
    });
  }, [items, query, kindFilter, statusFilter]);

  const effectiveSelectedId = selectedId ?? internalSelectedId ?? visibleItems[0]?.id ?? null;
  const selectedItem = items.find((item) => item.id === effectiveSelectedId) ?? null;
  const canConfigure = !selectedItem?.catalogOnly && selectedItem?.kind !== "skill" && selectedItem?.status !== "unsupported" && selectedItem?.status !== "planned";
  const canReconnect = !selectedItem?.catalogOnly && selectedItem?.kind !== "skill" && (selectedItem?.status === "configured" || selectedItem?.status === "liveVerified");
  const chooseItem = (item: CapabilityCatalogItem) => {
    setInternalSelectedId(item.id);
    onSelect?.(item);
  };

  return (
    <section className="flex h-full min-h-0 flex-col bg-[var(--bg)] text-[var(--fg)]" aria-labelledby="capability-catalog-title">
      <header className="shrink-0 border-b border-[var(--border-1)] bg-[var(--panel)] px-4 py-4 lg:px-8">
        <h1 id="capability-catalog-title" className="text-xl font-semibold">Capability catalog</h1>
        <p className="mt-1 max-w-3xl text-xs text-[var(--muted-foreground-2)]">
          Browse connectors, MCP servers, and skills. Skills describe procedures; tools and connectors expose capabilities.
        </p>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(18rem,0.9fr)_minmax(0,1.35fr)]">
        <div className="flex min-h-0 flex-col border-b border-[var(--border-1)] lg:border-b-0 lg:border-r">
          <div className="grid shrink-0 gap-2 border-b border-[var(--border-1)] p-3 sm:grid-cols-2">
            <label className="sm:col-span-2">
              <span className="sr-only">Search capabilities</span>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search capabilities"
                className="min-h-10 w-full border border-[var(--border-1)] bg-[var(--card)] px-3 text-xs text-[var(--fg)] outline-none placeholder:text-[var(--muted-foreground-3)] focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--primary)]/25"
              />
            </label>
            <label className="text-[10px] font-mono text-[var(--muted-foreground-2)]">
              <span className="sr-only">Filter by type</span>
              <select aria-label="Filter by type" value={kindFilter} onChange={(event) => setKindFilter(event.target.value as typeof kindFilter)} className="min-h-9 w-full border border-[var(--border-1)] bg-[var(--card)] px-2 text-xs text-[var(--fg)]">
                <option value="all">All types</option>
                <option value="connector">Connectors</option>
                <option value="mcp">MCP servers</option>
                <option value="skill">Skills</option>
              </select>
            </label>
            <label className="text-[10px] font-mono text-[var(--muted-foreground-2)]">
              <span className="sr-only">Filter by status</span>
              <select aria-label="Filter by status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)} className="min-h-9 w-full border border-[var(--border-1)] bg-[var(--card)] px-2 text-xs text-[var(--fg)]">
                <option value="all">All statuses</option>
                <option value="available">Available</option>
                <option value="configured">Configured</option>
                <option value="liveVerified">Live verified</option>
                <option value="unsupported">Unsupported</option>
                <option value="planned">Planned</option>
              </select>
            </label>
          </div>

          <ul aria-label="Capabilities" className="min-h-0 flex-1 overflow-y-auto">
            {visibleItems.map((item) => (
              <li key={item.id} className="border-b border-[var(--border-1)] last:border-b-0">
                <button
                  type="button"
                  onClick={() => chooseItem(item)}
                  aria-pressed={item.id === effectiveSelectedId}
                  className={`w-full px-4 py-3 text-left transition-colors hover:bg-[var(--card-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--primary)] ${item.id === effectiveSelectedId ? "bg-[var(--primary-soft)]" : "bg-[var(--card)]"}`}
                >
                  <span className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold text-sm">{item.name}</span>
                    <StatusLabel status={item.status} />
                  </span>
                  <span className="mt-1 block text-[10px] font-mono text-[var(--muted-foreground-2)]">{kindLabel(item.kind)} · {item.category}</span>
                  <span className="mt-1 block text-xs leading-relaxed text-[var(--muted-foreground-1)]">{item.summary}</span>
                </button>
              </li>
            ))}
            {visibleItems.length === 0 ? (
              <li className="p-6 text-center text-xs text-[var(--muted-foreground-2)]" role="status">No capabilities match these filters.</li>
            ) : null}
          </ul>
        </div>

        <aside className="min-h-0 overflow-y-auto p-4 lg:p-6" aria-label="Capability details" aria-live="polite">
          {selectedItem ? (
            <div className="mx-auto max-w-2xl">
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--border-1)] pb-4">
                <div>
                  <p className="text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">{kindLabel(selectedItem.kind)} · {selectedItem.category}</p>
                  <h2 className="mt-1 text-2xl font-semibold">{selectedItem.name}</h2>
                </div>
                <StatusLabel status={selectedItem.status} />
              </div>
              <p className="py-4 text-sm leading-relaxed">{selectedItem.description ?? selectedItem.summary}</p>
              <div className="grid gap-4 sm:grid-cols-2">
                <section>
                  <h3 className="text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">Action capabilities</h3>
                  <ul className="mt-2 list-disc space-y-1 pl-4 text-xs">
                    {selectedItem.capabilities.map((capability) => <li key={capability}>{capability}</li>)}
                  </ul>
                </section>
                <section>
                  <h3 className="text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">Requested scopes</h3>
                  {selectedItem.requestedScopes?.length ? (
                    <ul className="mt-2 flex flex-wrap gap-1.5">
                      {selectedItem.requestedScopes.map((scope) => <li key={scope} className="border border-[var(--border-1)] bg-[var(--section)] px-2 py-1 font-mono text-[10px]">{scope}</li>)}
                    </ul>
                  ) : <p className="mt-2 text-xs text-[var(--muted-foreground-2)]">No scopes listed.</p>}
                </section>
              </div>
              {selectedItem.requiredScope || selectedItem.writeEffect || selectedItem.version ? (
                <section className="mt-5 border-t border-[var(--border-1)] pt-4" aria-label="Execution contract">
                  <h3 className="text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">Execution contract</h3>
                  <dl className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
                    {selectedItem.requiredScope ? <div><dt className="text-[var(--muted-foreground-2)]">Required MCP scope</dt><dd className="font-mono">{selectedItem.requiredScope}</dd></div> : null}
                    {selectedItem.writeEffect ? <div><dt className="text-[var(--muted-foreground-2)]">Effect classification</dt><dd>{selectedItem.writeEffect.replaceAll("_", " ")}</dd></div> : null}
                    {selectedItem.approval ? <div><dt className="text-[var(--muted-foreground-2)]">Approval metadata</dt><dd>{selectedItem.approval.replaceAll("_", " ")}</dd></div> : null}
                    {selectedItem.verification ? <div><dt className="text-[var(--muted-foreground-2)]">Verification</dt><dd>{selectedItem.verification.replaceAll("_", " ")}</dd></div> : null}
                    {selectedItem.version ? <div><dt className="text-[var(--muted-foreground-2)]">Catalog version</dt><dd className="font-mono">{selectedItem.version}</dd></div> : null}
                    {selectedItem.schemaVersion ? <div><dt className="text-[var(--muted-foreground-2)]">Input schema version</dt><dd className="font-mono">{selectedItem.schemaVersion}</dd></div> : null}
                  </dl>
                  {selectedItem.inputSchema ? <details className="mt-3"><summary className="cursor-pointer text-xs">View bounded input schema</summary><pre className="mt-2 max-h-72 overflow-auto border border-[var(--border-1)] bg-[var(--section)] p-3 text-[10px]">{JSON.stringify(selectedItem.inputSchema, null, 2)}</pre></details> : null}
                </section>
              ) : null}
              {selectedItem.catalogOnly ? (
                <div className="mt-5 border-l-2 border-[var(--info)] bg-[var(--primary-soft)] p-3 text-xs" role="note">
                  <p>This is a catalog entry, not an assigned permission. MCP calls require an agent token with the listed scope. Catalog discovery did not verify a provider or execute a tool.</p>
                  <p className="mt-2">MCP endpoint: <code className="font-mono">/mcp</code></p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {onConnectMcp ? <button type="button" onClick={onConnectMcp} className="min-h-9 border border-[var(--border-1)] bg-[var(--card)] px-3 text-xs font-semibold">Open Agents &amp; MCP</button> : null}
                    {onViewToolHistory ? <button type="button" onClick={onViewToolHistory} className="min-h-9 border border-[var(--border-1)] bg-[var(--card)] px-3 text-xs font-semibold">Approvals &amp; call history</button> : null}
                  </div>
                </div>
              ) : null}
              {selectedItem.authNote ? <p className="mt-5 border-l-2 border-[var(--warning)] bg-[var(--warning-subtle)] p-3 text-xs" role="note">{selectedItem.authNote}</p> : null}

              <div className="mt-6 flex flex-wrap gap-2 border-t border-[var(--border-1)] pt-4" aria-label="Integration actions">
                {onConfigure && canConfigure ? <button type="button" onClick={() => onConfigure(selectedItem)} className="min-h-10 border border-[var(--primary)] bg-[var(--primary)] px-3 text-xs font-semibold text-[var(--primary-text)]">Configure</button> : null}
                {onReconnect && canReconnect ? <button type="button" onClick={() => onReconnect(selectedItem)} className="min-h-10 border border-[var(--border-1)] bg-[var(--card)] px-3 text-xs font-semibold">Reconnect</button> : null}
                {onCheckHealth && canReconnect ? <button type="button" onClick={() => onCheckHealth(selectedItem)} className="min-h-10 border border-[var(--border-1)] bg-[var(--card)] px-3 text-xs font-semibold">Check health</button> : null}
                {(!onConfigure || !canConfigure) && (!onReconnect || !canReconnect) && (!onCheckHealth || !canReconnect) ? <p className="text-xs text-[var(--muted-foreground-2)]">Actions are not available for this capability.</p> : null}
              </div>
            </div>
          ) : <p className="p-4 text-sm text-[var(--muted-foreground-2)]">Choose a capability to inspect its details.</p>}
        </aside>
      </div>
    </section>
  );
}
