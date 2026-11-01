import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import type { IntegrationProviderCatalogItem } from "@shiba/shared";
import { ToneChip } from "./ToneChip";

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

export function IntegrationsBrowseCatalogDialog({
  open,
  onClose,
  onConnect,
  connectingKey,
  linkedConnectorKeys,
  onLinkExisting,
  linkingKey,
  linkActionLabel = "Add to view",
}: {
  open: boolean;
  onClose: () => void;
  onConnect?: (item: IntegrationProviderCatalogItem) => void;
  connectingKey?: string | null;
  linkedConnectorKeys?: ReadonlySet<string>;
  onLinkExisting?: (item: IntegrationProviderCatalogItem) => void;
  linkingKey?: string | null;
  linkActionLabel?: string;
}): JSX.Element | null {
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<IntegrationProviderCatalogItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPage = useCallback(
    async (opts: { reset: boolean; query: string; nextCursor: string | null }) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        params.set("limit", "20");
        if (opts.query.trim()) params.set("query", opts.query.trim());
        if (!opts.reset && opts.nextCursor) params.set("cursor", opts.nextCursor);
        const response = await fetch(`/api/integrations/provider/catalog?${params.toString()}`, {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!response.ok) throw new Error(`Catalog unavailable (${response.status}).`);
        const body = (await response.json()) as {
          items?: IntegrationProviderCatalogItem[];
          nextCursor?: string | null;
          hasMore?: boolean;
        };
        const pageItems = Array.isArray(body.items) ? body.items : [];
        setItems((prev) => (opts.reset ? pageItems : [...prev, ...pageItems]));
        setCursor(body.nextCursor ?? null);
        setHasMore(Boolean(body.hasMore));
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (!open) return;
    setItems([]);
    setCursor(null);
    void loadPage({ reset: true, query: search, nextCursor: null });
  }, [open, loadPage]);

  useEffect(() => {
    if (!open) return;
    const handle = window.setTimeout(() => {
      void loadPage({ reset: true, query: search, nextCursor: null });
    }, 250);
    return () => window.clearTimeout(handle);
  }, [search, open, loadPage]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Browse integration catalog"
    >
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--panel)] shadow-[var(--sh-card)]">
        <div className="flex items-center justify-between gap-3 border-b border-[var(--border-1)] px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold text-[var(--fg)]">Browse catalog</h3>
            <p className="text-xs text-[var(--muted-foreground-2)]">Search SaaS connectors from the configured provider.</p>
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
          {error ? <p className="mt-2 text-xs text-[var(--warning-fg)]">{error}</p> : null}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {items.length === 0 && !loading ? (
            <p className="px-4 py-8 text-center text-sm text-[var(--muted-foreground-2)]">No connectors match.</p>
          ) : (
            items.map((item) => {
              const logo = safeLogoUrl(item.logoUrl);
              return (
                <div
                  key={`${item.source}:${item.providerKey}`}
                  className="flex gap-3 border-b border-[var(--border-1)] px-4 py-3 last:border-b-0"
                >
                  {logo ? (
                    <img src={logo} alt="" className="mt-0.5 h-8 w-8 rounded border border-[var(--border-1)] bg-white object-contain" />
                  ) : (
                    <div className="mt-0.5 flex h-8 w-8 items-center justify-center rounded border border-[var(--border-1)] bg-[var(--card)] text-[10px] font-semibold">
                      {item.name.slice(0, 2).toUpperCase()}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13px] font-semibold">{item.name}</span>
                      {item.isConnected ? <ToneChip tone="ok" label="Connected" /> : null}
                      {item.priority === "P0" ? (
                        <span className="font-mono text-[10px] text-[var(--muted-foreground-2)]">P0</span>
                      ) : null}
                    </div>
                    <p className="mt-0.5 text-xs text-[var(--muted-foreground-2)]">{item.description}</p>
                  </div>
                  {item.connectable && onConnect && !item.isConnected ? (
                    <button
                      type="button"
                      disabled={connectingKey === item.providerKey}
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
          <span className="text-[11px] text-[var(--muted-foreground-2)]">{loading ? "Loading…" : `${items.length} shown`}</span>
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
