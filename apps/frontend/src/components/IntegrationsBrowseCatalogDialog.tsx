import { IntegrationLogo } from "./IntegrationLogo";
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import type { IntegrationProviderCatalogItem, IntegrationProviderSetupState } from "@shiba/shared";
import { ToneChip } from "./ToneChip";
import { RoleCapabilityFilter } from "./RoleCapabilityFilter";
import { integrationRecommendedForRole, type CapabilityRoleFilter } from "../role-capability-recommendations";
import { teamWorkspaceHeaders } from "../team-workspaces-client";
import { integrationProviderReadError } from "../integration-oauth";

const READINESS_OPTIONS: readonly [IntegrationProviderSetupState | "all", string][] = [
  ["all", "All services"],
  ["ready", "Ready to connect"],
  ["needs_configuration", "Needs OAuth configuration"],
  ["unsupported", "No OAuth sign-in"],
  ["unverified", "Unverified"],
];

/** Labels come from provider setup metadata only; a listing is never shown as live. */
export function catalogReadinessLabel(item: IntegrationProviderCatalogItem): string {
  if (item.isConnected) return "Account configured";
  if (item.connectable) return "Sign-in available";
  if (item.setupState === "needs_configuration") return "OAuth app setup required";
  if (item.setupState === "unverified") return "Readiness unverified";
  if (item.setupState === "unsupported") return item.authTypes?.length ? `No OAuth sign-in (${item.authTypes.join(", ")})` : "No OAuth sign-in";
  return "Operator setup required";
}

type BrowseProps = { open: boolean; actorId?: string | null; workspaceId?: string; onClose: () => void; onAccessLost?: () => void; onConnect?: (item: IntegrationProviderCatalogItem) => void; connectingKey?: string | null; connectionError?: string | null; connectionNotice?: string | null; connectionRevision?: number; linkedConnectorKeys?: ReadonlySet<string>; onLinkExisting?: (item: IntegrationProviderCatalogItem) => void; linkingKey?: string | null; linkActionLabel?: string; roleFilter?: CapabilityRoleFilter };
/** Scope catalog state to the current actor and workspace before rendering its dialog. */
export function IntegrationsBrowseCatalogDialog(props: BrowseProps): JSX.Element | null {
  const scope = `${props.actorId ?? "legacy"}\0${props.workspaceId ?? "personal"}`;
  const actor = useRef(scope); actor.current = scope;
  return <ScopedBrowseCatalog key={scope} {...props} isCurrent={() => actor.current === scope} />;
}
/** Load and filter catalog pages while fencing stale requests after scope changes. */
function ScopedBrowseCatalog({
  open,
  onClose,
  onAccessLost,
  onConnect,
  connectingKey,
  connectionError,
  connectionNotice,
  connectionRevision = 0,
  linkedConnectorKeys,
  onLinkExisting,
  linkingKey,
  linkActionLabel = "Add to view",
  roleFilter = "all",
  actorId, workspaceId, isCurrent,
}: BrowseProps & { isCurrent: () => boolean }): JSX.Element | null {
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<IntegrationProviderCatalogItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState<CapabilityRoleFilter>(roleFilter);
  const [readiness, setReadiness] = useState<IntegrationProviderSetupState | "all">("all");
  const [totals, setTotals] = useState<{ total: number; oauthCapable: number } | null>(null);
  const controller = useRef<AbortController | null>(null), epoch = useRef(0), mounted = useRef(true), visible = useRef(open);
  const dialog = useRef<HTMLDivElement>(null), close = useRef(onClose), accessLost = useRef(onAccessLost); close.current = onClose; accessLost.current = onAccessLost;
  visible.current = open;
  const scopeCheck = useRef(isCurrent); scopeCheck.current = isCurrent;
  const active = useCallback(() => mounted.current && scopeCheck.current() && visible.current, []);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; epoch.current++; controller.current?.abort(); }; }, []);
  useEffect(() => { if (open) setRole(roleFilter); }, [open, roleFilter]);
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLElement>('input[type="search"]')?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopPropagation(); close.current(); return; }
      if (event.key !== "Tab" || !dialog.current) return;
      const root = dialog.current;
      const items = Array.from(root.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')).filter((item) => !item.hidden);
      const first = items[0], last = items[items.length - 1];
      if (!first || !last) return;
      if (!root.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("keydown", key, true); if (opener?.isConnected && opener !== document.body) opener.focus(); };
  }, [open]);
  const visibleItems = useMemo(() => {
    const query = search.trim().toLowerCase();
    return items.filter((item) => integrationRecommendedForRole(role, undefined, item) &&
      (!query || [item.name, item.description, item.providerKey].some((value) => value?.toLowerCase().includes(query))));
  }, [items, role, search]);

  const loadPage = useCallback(
    async (opts: { reset: boolean; query: string; nextCursor: string | null }) => {
      if (!active() || actorId === null) return;
      controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
      const generation = ++epoch.current;
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        params.set("limit", "20");
        if (opts.query.trim()) params.set("query", opts.query.trim());
        if (!opts.reset && opts.nextCursor) params.set("cursor", opts.nextCursor);
        if (readiness !== "all") params.set("readiness", readiness);
        const response = await fetch(`${workspaceId ? "/api/workspace-integrations/catalog" : "/api/integrations/provider/catalog"}?${params.toString()}`, {
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
          signal: abort.signal,
          headers: teamWorkspaceHeaders(workspaceId),
        });
        if (!response.ok) {
          if (workspaceId && [401, 403, 404].includes(response.status) && active() && generation === epoch.current && !abort.signal.aborted) accessLost.current?.();
          throw new Error(workspaceId ? `Catalog unavailable (${response.status}).` : integrationProviderReadError(response.status, await response.json().catch(() => null), `Catalog unavailable (${response.status}).`));
        }
        const body = (await response.json()) as {
          items?: IntegrationProviderCatalogItem[];
          nextCursor?: string | null;
          hasMore?: boolean;
          workspaceId?: string;
          total?: number;
          oauthCapable?: number;
        };
        if (!active() || generation !== epoch.current || abort.signal.aborted) return;
        if (!Array.isArray(body.items)) throw new Error("Invalid provider catalog response.");
        if (workspaceId && body.workspaceId !== workspaceId) throw new Error("The catalog belongs to another workspace. Refresh before connecting.");
        const pageItems = Array.isArray(body.items) ? body.items : [];
        setItems((prev) => [...new Map((opts.reset ? pageItems : [...prev, ...pageItems]).map((item) => [item.providerKey, item])).values()]);
        setCursor(body.nextCursor ?? null);
        setHasMore(Boolean(body.hasMore));
        setTotals(typeof body.total === "number" && typeof body.oauthCapable === "number" ? { total: body.total, oauthCapable: body.oauthCapable } : null);
      } catch (loadError) {
        if (active() && generation === epoch.current && !abort.signal.aborted) { setItems([]); setHasMore(false); setTotals(null); setError(loadError instanceof Error ? loadError.message : String(loadError)); }
      } finally {
        if (active() && generation === epoch.current && !abort.signal.aborted) setLoading(false);
      }
    },
    [active, actorId, workspaceId, readiness],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: Confirmed owner-account revisions invalidate the open catalog without dropping filters.
  useEffect(() => {
    epoch.current++; controller.current?.abort();
    if (!open || actorId === null) { setItems([]); return; }
    setItems([]);
    setCursor(null);
    const handle = window.setTimeout(() => {
      void loadPage({ reset: true, query: search, nextCursor: null });
    }, search.trim() ? 250 : 0);
    return () => { window.clearTimeout(handle); epoch.current++; controller.current?.abort(); };
  }, [search, open, loadPage, actorId, connectionRevision]);

  if (!open) return null;

  return (
    <div
      ref={dialog}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Browse integration catalog"
    >
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--panel)] shadow-[var(--sh-card)]">
        <div className="flex items-center justify-between gap-3 border-b border-[var(--border-1)] px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold text-[var(--fg)]">Browse catalog</h3>
            <p className="text-xs text-[var(--muted-foreground-2)]">Search the configured provider. A listing is not an installed app or an employee permission.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-[var(--radius-button)] border border-[var(--border-1)] px-2 py-1 text-xs font-semibold hover:bg-[var(--card-hover)]"
          >
            Close
          </button>
        </div>
        <div className="border-b border-[var(--border-1)] px-4 py-3">
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search connectors…"
            aria-label="Search connector catalog"
            className="w-full rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] px-3 py-2 text-sm"
          />
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <RoleCapabilityFilter value={role} onChange={setRole} label="Catalog recommendations for role" />
            <select aria-label="Filter by readiness" value={readiness} onChange={(event) => setReadiness(event.target.value as IntegrationProviderSetupState | "all")} className="rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] px-2 py-1 text-xs">
              {READINESS_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </div>
          {connectionError && <p role="alert" className="mt-2 text-xs text-[var(--danger-fg)]">{connectionError}</p>}
          {connectionNotice && <p role="status" className="mt-2 text-xs text-[var(--muted-foreground-2)]">{connectionNotice}</p>}
          {totals ? <p className="mt-2 text-[11px] text-[var(--muted-foreground-2)]">{totals.total} provider services match · {totals.oauthCapable} declare OAuth sign-in. OAuth client readiness is checked per loaded page.</p> : null}
          {error ? <div className="mt-2">
            <p role="alert" className="text-xs text-[var(--warning-fg)]">{error}</p>
            <button type="button" disabled={loading} onClick={() => void loadPage({ reset: true, query: search, nextCursor: null })} className="mt-2 min-h-11 border border-[var(--border-1)] px-3 text-xs disabled:opacity-50">Retry catalog</button>
          </div> : null}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {visibleItems.length === 0 && !loading && !error && actorId !== null ? (
            <p className="px-4 py-8 text-center text-sm text-[var(--muted-foreground-2)]">No connectors match on this page. {hasMore ? "Load more to search additional provider entries." : "Try another role or search."}</p>
          ) : (
            visibleItems.map((item) => {
              return (
                <div
                  key={`${item.source}:${item.providerKey}`}
                  className="flex gap-3 border-b border-[var(--border-1)] px-4 py-3 last:border-b-0"
                >
                  <IntegrationLogo providerKey={item.providerKey} logoUrl={item.logoUrl} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13px] font-semibold">{item.name}</span>
                      <ToneChip tone={item.isConnected ? "ok" : "neutral"} label={catalogReadinessLabel(item)} />
                      {item.priority === "P0" ? (
                        <span className="font-mono text-[10px] text-[var(--muted-foreground-2)]">P0</span>
                      ) : null}
                    </div>
                    <p className="mt-0.5 text-xs text-[var(--muted-foreground-2)]">{item.description}</p>
                  </div>
                  {item.connectable && onConnect && !item.isConnected ? (
                    <button
                      type="button"
                      disabled={Boolean(connectingKey)}
                      onClick={() => onConnect(item)}
                      className="self-start rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] px-2.5 py-1 text-[11px] font-mono font-medium text-[var(--primary)] hover:bg-[var(--primary)]/5 disabled:opacity-50"
                    >
                      {connectingKey === item.providerKey ? "Connecting…" : "Connect"}
                    </button>
                  ) : null}
                  {item.isConnected && item.connectionId && onLinkExisting && !linkedConnectorKeys?.has(item.providerKey) ? (
                    <button
                      type="button"
                      disabled={linkingKey === item.providerKey}
                      onClick={() => onLinkExisting(item)}
                      className="self-start rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] px-2.5 py-1 text-[11px] font-mono font-medium text-[var(--primary)] hover:bg-[var(--primary)]/5 disabled:opacity-50"
                    >
                      {linkingKey === item.providerKey ? "Adding…" : linkActionLabel}
                    </button>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
        <div className="flex justify-between gap-2 border-t border-[var(--border-1)] px-4 py-3">
          <span className="text-[11px] text-[var(--muted-foreground-2)]">{loading ? "Loading…" : error ? "Provider catalog not loaded" : `${visibleItems.length} shown · ${items.length} loaded`}</span>
          {hasMore ? (
            <button
              type="button"
              disabled={loading}
              onClick={() => void loadPage({ reset: false, query: search, nextCursor: cursor })}
              className="rounded-[var(--radius-button)] border border-[var(--border-1)] px-3 py-1 text-xs font-semibold hover:bg-[var(--card-hover)] disabled:opacity-50"
            >
              Show more
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
