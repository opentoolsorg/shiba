import {
  INTEGRATION_CATALOG,
  integrationCatalogDomains,
  type IntegrationCatalogEntry,
  type IntegrationConnectionPhase,
  type IntegrationDomain,
  type IntegrationProviderCatalogItem,
  type IntegrationProviderHealth,
} from "@shiba/shared";
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import { ownedAppConnections, useIntegrationOAuth } from "../integration-oauth";
import {
  buildIntegrationConnectionSnapshot,
  connectionPhaseLabel,
  type IntegrationBindingInputs,
} from "../integration-connection-bindings";
import { IntegrationsBrowseCatalogDialog } from "./IntegrationsBrowseCatalogDialog";
import { ToneChip } from "./ToneChip";
import { RoleCapabilityFilter } from "./RoleCapabilityFilter";
import { integrationRecommendedForRole, type CapabilityRoleFilter } from "../role-capability-recommendations";
import { CURATED_MCP_VENDORS } from "@shiba/shared";

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
    case "openconnector":
      return "open-connector";
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
    const connected = phase === "configured";
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
    const catalogEntry = INTEGRATION_CATALOG.find((e) =>
      e.id === item.providerKey || e.id === item.id ||
      (item.source === "openconnector" && e.openConnectorServiceIds?.includes(item.providerKey)),
    );
    const connected = connectedKeys.has(item.providerKey);
    const existing = catalogEntry ? byKey.get(catalogEntry.id) : undefined;
    if (catalogEntry && existing && (catalogEntry.openConnectorServiceIds?.length ?? 0) <= 1) {
      byKey.set(catalogEntry.id, {
        ...existing,
        connected: existing.connected || connected,
        providerItem: { ...item, isConnected: connected },
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
      providerItem: { ...item, isConnected: connected },
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
  onConnect,
}: {
  title: string;
  hint: string;
  rows: DisplayRow[];
  visibleCount: number;
  onShowMore: () => void;
  emptyLabel: string;
  onOpenDocs?: (entry: IntegrationCatalogEntry) => void;
  onConnect?: (item: IntegrationProviderCatalogItem) => void;
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
                      <ToneChip tone={phaseChip.tone} label={row.providerItem?.isConnected ? "Account configured" : phaseChip.label} />
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
                <div className="flex shrink-0 flex-wrap gap-2">
                {row.providerItem?.connectable && !row.providerItem.isConnected && onConnect ? <button type="button" onClick={() => { if (row.providerItem) onConnect(row.providerItem); }} className="min-h-11 border border-[var(--border-1)] px-3 text-xs text-[var(--primary)]">Connect app</button> : null}
                {row.providerItem && !row.providerItem.connectable && !row.providerItem.isConnected ? <span className="self-center text-[10px] text-[var(--muted-foreground-2)]">{row.providerItem.setupState === "needs_configuration" ? "OAuth app setup required" : row.providerItem.setupState === "unverified" ? "Sign-in readiness unverified" : "Operator credential setup required"}</span> : null}
                {entry && CURATED_MCP_VENDORS.some((vendor) => vendor.catalogId === entry.id) ? <a href={`/integrations/?tab=mcp#mcp-preset-${entry.id}`} className="inline-flex min-h-11 items-center border border-[var(--border-1)] px-3 text-xs text-[var(--primary)]">Configure MCP</a> : null}
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

type DirectoryProps = {
  bindingInputs: IntegrationBindingInputs; actorId?: string | null; onOpenDocs?: (entry: IntegrationCatalogEntry) => void;
  linkedConnectorKeys?: ReadonlySet<string>; onLinkExisting?: (item: IntegrationProviderCatalogItem) => void;
  linkActionLabel?: string; linkingKey?: string | null; onConnectStarted?: (providerKey: string) => void; onOAuthComplete?: () => void;
  onRequestConnect?: (item: IntegrationProviderCatalogItem) => void; connectingKey?: string | null;
  /** Invalidate owned-account reads after a verified parent connect/disconnect. Never grants access. */
  connectionRevision?: number;
};
export function IntegrationCatalogDirectory(props: DirectoryProps): JSX.Element {
  const actor = useRef(props.actorId); actor.current = props.actorId;
  return <ScopedIntegrationCatalogDirectory key={props.actorId ?? "legacy"} {...props} isCurrent={() => actor.current === props.actorId} />;
}
function ScopedIntegrationCatalogDirectory({
  bindingInputs,
  onOpenDocs,
  linkedConnectorKeys,
  onLinkExisting,
  linkActionLabel,
  linkingKey,
  onConnectStarted,
  onOAuthComplete,
  actorId, onRequestConnect, connectingKey: externalConnectingKey, connectionRevision = 0, isCurrent,
}: DirectoryProps & { isCurrent: () => boolean }): JSX.Element {
  const [search, setSearch] = useState("");
  const [domain, setDomain] = useState<IntegrationDomain | "all">("all");
  const [recommendedOnly, setRecommendedOnly] = useState(false);
  const [role, setRole] = useState<CapabilityRoleFilter>("all");
  const [connectedVisible, setConnectedVisible] = useState(LIST_PAGE_SIZE);
  const [availableVisible, setAvailableVisible] = useState(LIST_PAGE_SIZE);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [providerHealth, setProviderHealth] = useState<IntegrationProviderHealth | null>(null);
  const [providerItems, setProviderItems] = useState<IntegrationProviderCatalogItem[]>([]);
  const [connectedKeys, setConnectedKeys] = useState<Set<string>>(() => new Set());
  const [catalogCursor, setCatalogCursor] = useState<string | null>(null);
  const [catalogHasMore, setCatalogHasMore] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const controller = useRef(new AbortController()), alive = useRef(true), catalogEpoch = useRef(0), refreshEpoch = useRef(0);
  const scopeCheck = useRef(isCurrent); scopeCheck.current = isCurrent;
  const active = useCallback(() => alive.current && scopeCheck.current() && !controller.current.signal.aborted, []);

  const loadProviderCatalogPage = useCallback(async (opts: { reset: boolean; cursor?: string | null }) => {
    const generation = ++catalogEpoch.current;
    setCatalogLoading(true);
    if (opts.reset) { setProviderItems([]); setCatalogCursor(null); setCatalogHasMore(false); }
    try {
      const params = new URLSearchParams();
      params.set("limit", "20");
      if (!opts.reset && opts.cursor) params.set("cursor", opts.cursor);
      const catalogRes = await fetch(`/api/integrations/provider/catalog?${params.toString()}`, {
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.current.signal,
      });
      if (!catalogRes.ok) throw new Error(`Provider catalog unavailable (${catalogRes.status}).`);
      const catalog = (await catalogRes.json()) as {
        items?: IntegrationProviderCatalogItem[];
        nextCursor?: string | null;
        hasMore?: boolean;
        fallbackCatalog?: boolean;
      };
      if (!active() || generation !== catalogEpoch.current) return;
      if (!Array.isArray(catalog.items)) throw new Error("Invalid provider catalog response.");
      const pageItems = Array.isArray(catalog.items) ? catalog.items : [];
      setProviderItems((prev) => [...new Map((opts.reset ? pageItems : [...prev, ...pageItems]).map((item) => [item.providerKey, item])).values()]);
      setCatalogCursor(catalog.nextCursor ?? null);
      setCatalogHasMore(Boolean(catalog.hasMore));
    } catch (cause) {
      if (active() && generation === catalogEpoch.current) { setProviderItems([]); setCatalogHasMore(false); setProviderError(cause instanceof Error ? cause.message : "Provider catalog unavailable."); }
    } finally {
      if (active() && generation === catalogEpoch.current) setCatalogLoading(false);
    }
  }, [active]);

  const refreshProvider = useCallback(async () => {
    if (!active() || actorId === null) return;
    const generation = ++refreshEpoch.current;
    setConnectedKeys(new Set()); setProviderHealth(null); setProviderError(null);
    const results = await Promise.allSettled([
      fetch("/api/integrations/provider/meta", { credentials: "same-origin", cache: "no-store", signal: controller.current.signal }).then(async (response) => { if (!response.ok) throw new Error("Provider readiness unavailable."); return await response.json() as { health?: IntegrationProviderHealth }; }),
      ownedAppConnections(controller.current.signal),
      loadProviderCatalogPage({ reset: true }),
    ]);
    if (!active() || generation !== refreshEpoch.current) return;
    const [meta, connections] = results;
    if (meta?.status === "fulfilled" && meta.value.health) setProviderHealth(meta.value.health);
    if (connections?.status === "fulfilled") setConnectedKeys(new Set(connections.value.map((row) => row.providerKey)));
    else setProviderError("Current app account state is unavailable. Previously connected badges were cleared; refresh before granting access.");
    if (meta?.status === "rejected") setProviderError("Provider readiness is unavailable. Refresh to verify current service authentication.");
  }, [actorId, active, loadProviderCatalogPage]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: A verified parent account revision invalidates this scoped cache while retaining filters.
  useEffect(() => {
    alive.current = true; controller.current = new AbortController();
    void refreshProvider();
    const focus = () => { void refreshProvider(); }; window.addEventListener("focus", focus);
    return () => { alive.current = false; refreshEpoch.current++; catalogEpoch.current++; controller.current.abort(); window.removeEventListener("focus", focus); };
  }, [refreshProvider, connectionRevision]);
  const oauth = useIntegrationOAuth({ actorId, onVerified: () => { if (active()) { void refreshProvider(); onOAuthComplete?.(); } } });
  const connectingKey = externalConnectingKey ?? oauth.connectingKey;

  const allRows = useMemo(() => {
    const native = nativeRows(INTEGRATION_CATALOG, bindingInputs);
    const query = search.trim().toLowerCase();
    return mergeProviderRows(native, providerItems, connectedKeys).filter((row) =>
      (!query || [row.name, row.description, row.entry?.id, row.providerItem?.providerKey].some((value) => value?.toLowerCase().includes(query))) &&
      (domain === "all" || (row.providerItem?.domain ?? row.entry?.domain) === domain) &&
      (!recommendedOnly || (row.providerItem?.priority ?? row.entry?.priority) === "P0") &&
      integrationRecommendedForRole(role, row.entry?.id, row.providerItem));
  }, [search, domain, recommendedOnly, role, bindingInputs, providerItems, connectedKeys]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Changing a filter resets both independently paginated lists.
  useEffect(() => { setConnectedVisible(LIST_PAGE_SIZE); setAvailableVisible(LIST_PAGE_SIZE); }, [search, domain, recommendedOnly, role]);

  const connectedRows = useMemo(() => allRows.filter((row) => row.connected), [allRows]);
  const availableRows = useMemo(() => allRows.filter((row) => !row.connected), [allRows]);

  const beginConnect = (item: IntegrationProviderCatalogItem) => { onConnectStarted?.(item.providerKey); if (onRequestConnect) onRequestConnect(item); else void oauth.beginConnect(item); };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-3 border-b border-[var(--border-1)] bg-[var(--panel)] px-4 py-3 lg:px-8">
        {providerHealth ? (
          <p className="rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] px-3 py-2 text-xs text-[var(--muted-foreground-2)]">
            {providerHealth.message ??
              (providerHealth.status === "healthy" ? "Service reports healthy. App accounts, live actions and employee grants require separate verification." : "OpenConnector is not ready. Ask the operator to verify service credentials and OAuth app setup.")}
          </p>
        ) : null}
        {providerError || oauth.error ? (
          <p className="text-xs text-[var(--warning-fg)]" role="status">
            {providerError ?? oauth.error}
          </p>
        ) : null}
        {oauth.notice && <p role="status" className="text-xs text-[var(--muted-foreground-2)]">{oauth.notice}</p>}
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
          <RoleCapabilityFilter value={role} onChange={setRole} />
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
          {catalogHasMore ? (
            <button
              type="button"
              disabled={catalogLoading}
              onClick={() => void loadProviderCatalogPage({ reset: false, cursor: catalogCursor })}
              className="rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] px-3 py-1.5 text-xs font-semibold hover:bg-[var(--card-hover)] disabled:opacity-50"
            >
              {catalogLoading ? "Loading…" : "Load more integrations"}
            </button>
          ) : null}
        </div>
        <p className="text-[11px] text-[var(--muted-foreground-2)]">
          {connectedRows.length} matching configured or linked · {availableRows.length} matching entries need setup · {INTEGRATION_CATALOG.length} reference catalog entries ({INTEGRATION_CATALOG.filter((entry) => entry.status === "live").length} implemented product paths). {providerItems.length} provider listings loaded; {providerItems.filter((item) => item.connectable).length} report verified OAuth app setup.
          {" "}Recommendations do not install apps or grant employee access. Configuration, authentication, health and employee grants are separate steps.
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 lg:p-8">
        <div className="mx-auto flex max-w-6xl flex-col gap-8">
          <IntegrationSection
            title="Configured connections"
            hint="Deployment configuration or provider-linked accounts. This does not grant employee access or prove a successful live action."
            rows={connectedRows}
            visibleCount={connectedVisible}
            onShowMore={() => setConnectedVisible((value) => value + LIST_PAGE_SIZE)}
            emptyLabel="Nothing connected yet — finish native setup or connect a SaaS app from Available."
            onOpenDocs={onOpenDocs}
            onConnect={(item) => void beginConnect(item)}
          />
          <IntegrationSection
            title="Discover and set up"
            hint="Reference entries may require deployment support. Connect buttons appear only for provider-reported sign-in paths; MCP presets still require authentication, discovery and review."
            rows={availableRows}
            visibleCount={availableVisible}
            onShowMore={() => setAvailableVisible((value) => value + LIST_PAGE_SIZE)}
            emptyLabel="No available integrations match this filter."
            onOpenDocs={onOpenDocs}
            onConnect={(item) => void beginConnect(item)}
          />
        </div>
      </div>
      <IntegrationsBrowseCatalogDialog
        open={browseOpen}
        actorId={actorId}
        onClose={() => setBrowseOpen(false)}
        onConnect={(item) => void beginConnect(item)}
        connectingKey={connectingKey}
        linkedConnectorKeys={linkedConnectorKeys}
        onLinkExisting={onLinkExisting}
        linkActionLabel={linkActionLabel}
        linkingKey={linkingKey}
        roleFilter={role}
      />
    </div>
  );
}
