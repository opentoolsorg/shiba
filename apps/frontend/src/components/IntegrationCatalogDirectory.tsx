import {
  INTEGRATION_CATALOG,
  filterIntegrationCatalogView,
  integrationCatalogDomains,
  type IntegrationCatalogEntry,
  type IntegrationCatalogTab,
  type IntegrationDomain,
} from "@shiba/shared";
import { useMemo, useState, type JSX } from "react";
import {
  buildIntegrationConnectionSnapshot,
  connectionPhaseLabel,
  type IntegrationBindingInputs,
} from "../integration-connection-bindings";
import { ToneChip } from "./ToneChip";

const TABS: { id: IntegrationCatalogTab; label: string }[] = [
  { id: "recommended", label: "Recommended" },
  { id: "needs_attention", label: "Needs attention" },
  { id: "connected", label: "Connected" },
  { id: "all", label: "All" },
];

const DOMAIN_LABELS: Record<IntegrationDomain, string> = {
  marketing: "Marketing",
  sales: "Sales",
  ops: "Operations",
  revenue: "Revenue",
  design: "Design",
  pm: "Product & engineering",
};

function kindLabel(kind: IntegrationCatalogEntry["kind"]): string {
  switch (kind) {
    case "native":
      return "Native";
    case "mcp":
      return "Custom MCP";
    case "grokbot-bridge":
      return "Grok Bot bridge";
    case "webhook":
      return "Webhook";
    default:
      return kind;
  }
}

export function IntegrationCatalogDirectory({
  bindingInputs,
  onOpenDocs,
}: {
  bindingInputs: IntegrationBindingInputs;
  onOpenDocs?: (entry: IntegrationCatalogEntry) => void;
}): JSX.Element {
  const [search, setSearch] = useState("");
  const [domain, setDomain] = useState<IntegrationDomain | "all">("all");
  const [tab, setTab] = useState<IntegrationCatalogTab>("recommended");

  const connections = useMemo(
    () => buildIntegrationConnectionSnapshot(INTEGRATION_CATALOG, bindingInputs),
    [bindingInputs],
  );

  const visible = useMemo(
    () =>
      filterIntegrationCatalogView(INTEGRATION_CATALOG, {
        search,
        domain,
        tab,
        connections,
      }),
    [search, domain, tab, connections],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-3 border-b border-[var(--border-1)] bg-[var(--panel)] px-4 py-3 lg:px-8">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-[var(--muted-foreground-2)]">
            Search integrations
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="HubSpot, Slack, Stripe…"
              className="rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--fg)]"
              aria-label="Search integrations"
            />
          </label>
          <label className="flex shrink-0 flex-col gap-1 text-xs text-[var(--muted-foreground-2)] sm:w-52">
            Domain
            <select
              value={domain}
              onChange={(event) => setDomain(event.target.value as IntegrationDomain | "all")}
              className="rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--fg)]"
              aria-label="Filter by domain"
            >
              <option value="all">All domains</option>
              {integrationCatalogDomains().map((value) => (
                <option key={value} value={value}>
                  {DOMAIN_LABELS[value]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="Integration catalog tabs">
          {TABS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={`rounded-[var(--radius-button)] border px-3 py-1.5 text-xs font-semibold transition-colors ${
                tab === id
                  ? "border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--primary)]"
                  : "border-[var(--border-1)] bg-[var(--card)] text-[var(--muted-foreground-2)] hover:bg-[var(--card-hover)]"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-[var(--muted-foreground-2)]">
          {visible.length} of {INTEGRATION_CATALOG.length} integrations
          {tab === "connected" ? " with live or deployment-backed status" : ""}.
          Bridge rows use Grok Bot in PR C. Custom MCP rows connect above or via Agents & MCP.
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 lg:p-8">
        <div className="mx-auto max-w-6xl rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] shadow-[var(--sh-card)]">
          {visible.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-[var(--muted-foreground-2)]">
              No integrations match this filter.
            </p>
          ) : (
            visible.map((entry) => {
              const phase = connections[entry.id] ?? "catalog_only";
              const chip = connectionPhaseLabel(phase);
              return (
                <div
                  key={entry.id}
                  data-testid={`integration-catalog-row-${entry.id}`}
                  className="flex flex-col gap-2 border-b border-[var(--border-1)] px-4 py-3.5 last:border-b-0 sm:flex-row sm:items-start sm:justify-between sm:gap-4"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13px] font-semibold text-[var(--fg)]">{entry.name}</span>
                      <ToneChip tone={chip.tone} label={chip.label} />
                      <span className="rounded border border-[var(--border-1)] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-[var(--muted-foreground-2)]">
                        {DOMAIN_LABELS[entry.domain]}
                      </span>
                      <span className="font-mono text-[10px] text-[var(--muted-foreground-2)]">
                        {kindLabel(entry.kind)}
                      </span>
                    </div>
                    <p className="mt-1 text-xs leading-relaxed text-[var(--muted-foreground-2)]">{entry.summary}</p>
                  </div>
                  <a
                    href={entry.docsUrl}
                    target="_blank"
                    rel="noreferrer"
                    onClick={() => onOpenDocs?.(entry)}
                    className="shrink-0 self-start rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] px-2.5 py-1 text-[11px] font-mono font-medium text-[var(--primary)] transition-colors hover:border-[var(--primary)]/40 hover:bg-[var(--primary)]/5 sm:self-center"
                  >
                    Docs ↗
                  </a>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
