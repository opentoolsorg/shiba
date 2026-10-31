import {
  INTEGRATION_CATALOG,
  filterIntegrationCatalogByDomain,
  integrationCatalogDomains,
  searchIntegrationCatalog,
  type IntegrationCatalogEntry,
  type IntegrationConnectionPhase,
  type IntegrationDomain,
  type IntegrationProviderCatalogItem,
  type IntegrationProviderHealth,
  type IntegrationsProviderId,
} from "@shiba/shared";
import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import {
  buildIntegrationConnectionSnapshot,
  connectionPhaseLabel,
  type IntegrationBindingInputs,
} from "../integration-connection-bindings";
import { IntegrationsBrowseCatalogDialog } from "./IntegrationsBrowseCatalogDialog";
import { ToneChip } from "./ToneChip";

const LIST_PAGE_SIZE = 8;

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

function safeLogoUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    return url.href;
  } catch {
    return null;
  }
}

type DisplayRow = {
  key: string;
  name: string;
  description: string;
  connected: boolean;
  phase?: IntegrationConnectionPhase;
  entry?: IntegrationCatalogEntry;
  providerItem?: IntegrationProviderCatalogItem;
  logoUrl?: string | null;
  docsUrl?: string;
};

function nativeRows(
  entries: IntegrationCatalogEntry[],
  bindingInputs: IntegrationBindingInputs,
): DisplayRow[] {
  const connections = buildIntegrationConnectionSnapshot(entries, bindingInputs);
  return entries.map((entry) => {
    const phase = connections[entry.id] ?? "catalog_only";
    const connected = phase === "configured" || phase === "available_via_deployment";
    return {
      key: `native:${entry.id}`,
      name: entry.name,
      description: entry.summary,
      connected,
      phase,
      entry,
      docsUrl: entry.docsUrl,
    };
  });
}

function mergeProviderRows(
  native: DisplayRow[],
  providerItems: IntegrationProviderCatalogItem[],
  connectedKeys: Set<string>,
): DisplayRow[] {
  const byKey = new Map<string, DisplayRow>();
  for (const row of native) byKey.set(row.entry?.id ?? row.key, row);

  for (const item of providerItems) {
    const catalogEntry = INTEGRATION_CATALOG.find((e) => e.id === item.providerKey || e.id === item.id);
    const connected = item.isConnected || connectedKeys.has(item.providerKey);
    const existing = catalogEntry ? byKey.get(catalogEntry.id) : undefined;
    if (existing) {
      byKey.set(catalogEntry!.id, {
        ...existing,
        connected: existing.connected || connected,
        providerItem: item,
        logoUrl: safeLogoUrl(item.logoUrl),
        description: item.description || existing.description,
      });
      continue;
    }
    byKey.set(`provider:${item.providerKey}`, {
      key: `provider:${item.providerKey}`,
      name: item.name,
      description: item.description,
      connected,
      providerItem: item,
      logoUrl: safeLogoUrl(item.logoUrl),
      docsUrl: item.docsUrl,
      entry: catalogEntry,
    });
  }

  return [...byKey.values()];
}

function IntegrationSection({
  title,
  hint,
  rows,
  visibleCount,
  onShowMore,
  emptyLabel,
  onOpenDocs,
}: {
  title: string;
  hint: string;
  rows: DisplayRow[];
  visibleCount: number;
  onShowMore: () => void;
  emptyLabel: string;
  onOpenDocs?: (entry: IntegrationCatalogEntry) => void;
}): JSX.Element {
  const visible = rows.slice(0, visibleCount);
  return (
    <section className="flex flex-col gap-2">
      <div>
        <h3 className="text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">
          {title}
        </h3>
        <p className="text-xs text-[var(--muted-foreground-2)]">{hint}</p>
      </div>
      <div className="rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] shadow-[var(--sh-card)]">
        {visible.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-[var(--muted-foreground-2)]">{emptyLabel}</p>
        ) : (
          visible.map((row) => {
            const entry = row.entry;
            const phaseChip = entry && row.phase
              ? connectionPhaseLabel(row.phase)
              : row.connected
                ? { tone: "ok" as const, label: "Connected" }
                : { tone: "neutral" as const, label: "Available" };
            const logo = row.logoUrl;
            return (
              <div
                key={row.key}
                data-testid={entry ? `integration-catalog-row-${entry.id}` : undefined}
                className="flex flex-col gap-2 border-b border-[var(--border-1)] px-4 py-3.5 last:border-b-0 sm:flex-row sm:items-start sm:justify-between sm:gap-4"
              >
                <div className="flex min-w-0 flex-1 gap-3">
                  {logo ? (
                    <img
                      src={logo}
                      alt=""
                      className="mt-0.5 h-9 w-9 shrink-0 rounded border border-[var(--border-1)] bg-white object-contain"
                    />
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13px] font-semibold text-[var(--fg)]">{row.name}</span>
                      <ToneChip tone={phaseChip.tone} label={row.connected ? "Connected" : phaseChip.label} />
                      {entry ? (
                        <>
                          <span className="rounded border border-[var(--border-1)] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-[var(--muted-foreground-2)]">
                            {DOMAIN_LABELS[entry.domain]}
                          </span>
                          <span className="font-mono text-[10px] text-[var(--muted-foreground-2)]">
                            {kindLabel(entry.kind)}
                          </span>
                          {entry.priority === "P0" ? (
                            <span className="font-mono text-[10px] text-[var(--primary)]">Recommended</span>
                          ) : null}
                        </>
                      ) : null}
                    </div>
                    <p className="mt-1 text-xs leading-relaxed text-[var(--muted-foreground-2)]">{row.description}</p>
                  </div>
                </div>
                {row.docsUrl ? (
                  <a
                    href={row.docsUrl}
                    target="_blank"
                    rel="noreferrer"
                    onClick={() => entry && onOpenDocs?.(entry)}
                    className="shrink-0 self-start rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] px-2.5 py-1 text-[11px] font-mono font-medium text-[var(--primary)] transition-colors hover:border-[var(--primary)]/40 hover:bg-[var(--primary)]/5 sm:self-center"
                  >
                    Docs ↗
                  </a>
                ) : null}
              </div>
            );
          })
        )}
      </div>
      {rows.length > visibleCount ? (
        <button
          type="button"
          onClick={onShowMore}
          className="self-start rounded-[var(--radius-button)] border border-[var(--border-1)] px-3 py-1.5 text-xs font-semibold hover:bg-[var(--card-hover)]"
        >
          Show more ({rows.length - visibleCount} remaining)
        </button>
      ) : null}
    </section>
  );
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
  const [recommendedOnly, setRecommendedOnly] = useState(false);
  const [connectedVisible, setConnectedVisible] = useState(LIST_PAGE_SIZE);
  const [availableVisible, setAvailableVisible] = useState(LIST_PAGE_SIZE);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [connectingKey, setConnectingKey] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [providerId, setProviderId] = useState<IntegrationsProviderId>("composio");
  const [providerHealth, setProviderHealth] = useState<IntegrationProviderHealth | null>(null);
  const [providerItems, setProviderItems] = useState<IntegrationProviderCatalogItem[]>([]);
  const [connectedKeys, setConnectedKeys] = useState<Set<string>>(() => new Set());

  const refreshProvider = useCallback(async () => {
    try {
      const [metaRes, catalogRes, connectionsRes] = await Promise.all([
        fetch("/api/integrations/provider/meta", { credentials: "same-origin", cache: "no-store" }),
        fetch("/api/integrations/provider/catalog?limit=50", { credentials: "same-origin", cache: "no-store" }),
        fetch("/api/integrations/provider/connections", { credentials: "same-origin", cache: "no-store" }),
      ]);
      if (metaRes.ok) {
        const meta = (await metaRes.json()) as { provider?: IntegrationsProviderId; health?: IntegrationProviderHealth };
        if (meta.provider) setProviderId(meta.provider);
        if (meta.health) setProviderHealth(meta.health);
      }
      if (catalogRes.ok) {
        const catalog = (await catalogRes.json()) as { items?: IntegrationProviderCatalogItem[] };
        setProviderItems(Array.isArray(catalog.items) ? catalog.items : []);
      }
      if (connectionsRes.ok) {
        const body = (await connectionsRes.json()) as { connections?: Array<{ providerKey: string }> };
        setConnectedKeys(new Set((body.connections ?? []).map((row) => row.providerKey)));
      }
    } catch {
      // Provider panel degrades to native Viktor catalog only.
    }
  }, []);

  useEffect(() => {
    void refreshProvider();
  }, [refreshProvider]);

  const filteredCatalog = useMemo(() => {
    let entries = searchIntegrationCatalog(INTEGRATION_CATALOG, search);
    entries = filterIntegrationCatalogByDomain(entries, domain);
    if (recommendedOnly) entries = entries.filter((entry) => entry.priority === "P0");
    return entries;
  }, [search, domain, recommendedOnly]);

  const allRows = useMemo(() => {
    const native = nativeRows(filteredCatalog, bindingInputs);
    return mergeProviderRows(native, providerItems, connectedKeys);
  }, [filteredCatalog, bindingInputs, providerItems, connectedKeys]);

  const connectedRows = useMemo(() => allRows.filter((row) => row.connected), [allRows]);
  const availableRows = useMemo(() => allRows.filter((row) => !row.connected), [allRows]);

  const beginConnect = useCallback(async (item: IntegrationProviderCatalogItem) => {
    setConnectingKey(item.providerKey);
    setConnectError(null);
    try {
      const response = await fetch("/api/integrations/provider/connect", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          providerKey: item.providerKey,
          callbackOrigin: window.location.origin,
        }),
      });
      const body = (await response.json()) as { ok?: boolean; redirectUrl?: string | null; error?: string };
      if (!response.ok || !body.ok || !body.redirectUrl) {
        throw new Error(body.error ?? "Connect unavailable.");
      }
      window.open(body.redirectUrl, "shiba-composio-oauth", "width=520,height=720");
      await refreshProvider();
    } catch (error) {
      setConnectError(error instanceof Error ? error.message : String(error));
    } finally {
      setConnectingKey(null);
    }
  }, [refreshProvider]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-3 border-b border-[var(--border-1)] bg-[var(--panel)] px-4 py-3 lg:px-8">
        {providerHealth?.status === "unconfigured" ? (
          <p className="rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] px-3 py-2 text-xs text-[var(--muted-foreground-2)]">
            {providerHealth.message ??
              `Configure Composio (${providerId}) to enable in-app SaaS OAuth. Showing static catalog stubs until COMPOSIO_API_KEY is set.`}
          </p>
        ) : null}
        {connectError ? (
          <p className="text-xs text-[var(--warning-fg)]" role="status">
            {connectError}
          </p>
        ) : null}
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
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            aria-pressed={recommendedOnly}
            onClick={() => setRecommendedOnly((value) => !value)}
            className={`rounded-[var(--radius-button)] border px-3 py-1.5 text-xs font-semibold ${
              recommendedOnly
                ? "border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--primary)]"
                : "border-[var(--border-1)] bg-[var(--card)] text-[var(--muted-foreground-2)]"
            }`}
          >
            Recommended (P0)
          </button>
          <button
            type="button"
            onClick={() => setBrowseOpen(true)}
            className="rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] px-3 py-1.5 text-xs font-semibold hover:bg-[var(--card-hover)]"
          >
            Browse catalog
          </button>
          <button
            type="button"
            onClick={() => void refreshProvider()}
            className="rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] px-3 py-1.5 text-xs font-semibold hover:bg-[var(--card-hover)]"
          >
            Refresh connections
          </button>
        </div>
        <p className="text-[11px] text-[var(--muted-foreground-2)]">
          {connectedRows.length} connected · {availableRows.length} available · {filteredCatalog.length} of{" "}
          {INTEGRATION_CATALOG.length} Viktor catalog rows (provider: {providerId}).
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 lg:p-8">
        <div className="mx-auto flex max-w-6xl flex-col gap-8">
          <IntegrationSection
            title="Connected"
            hint="Native deployment bindings and SaaS accounts linked through the integrations provider."
            rows={connectedRows}
            visibleCount={connectedVisible}
            onShowMore={() => setConnectedVisible((value) => value + LIST_PAGE_SIZE)}
            emptyLabel="Nothing connected yet — finish native setup or connect a SaaS app from Available."
            onOpenDocs={onOpenDocs}
          />
          <IntegrationSection
            title="Available"
            hint="Catalog entries you can wire next — native setup, MCP OAuth, Grok Bot bridge, or Composio OAuth."
            rows={availableRows}
            visibleCount={availableVisible}
            onShowMore={() => setAvailableVisible((value) => value + LIST_PAGE_SIZE)}
            emptyLabel="No available integrations match this filter."
            onOpenDocs={onOpenDocs}
          />
        </div>
      </div>
      <IntegrationsBrowseCatalogDialog
        open={browseOpen}
        onClose={() => setBrowseOpen(false)}
        onConnect={(item) => void beginConnect(item)}
        connectingKey={connectingKey}
      />
    </div>
  );
}
