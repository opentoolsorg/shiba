import {
  INTEGRATION_CATALOG,
  type IntegrationCatalogEntry,
  type IntegrationProviderCatalogItem,
} from "@shiba/shared";

export function catalogEntryToProviderItem(
  entry: IntegrationCatalogEntry,
  opts: {
    source: IntegrationProviderCatalogItem["source"];
    isConnected?: boolean;
    connectionId?: string | null;
    connectable?: boolean;
  },
): IntegrationProviderCatalogItem {
  return {
    id: entry.id,
    providerKey: entry.id,
    name: entry.name,
    description: entry.summary,
    domain: entry.domain,
    kind: entry.kind,
    priority: entry.priority,
    docsUrl: entry.docsUrl,
    logoUrl: null,
    isConnected: opts.isConnected ?? false,
    connectionId: opts.connectionId ?? null,
    source: opts.source,
    connectable: opts.connectable ?? false,
  };
}

export function staticCatalogPage(args: {
  query?: string;
  cursor?: string;
  limit: number;
  filter?: (entry: IntegrationCatalogEntry) => boolean;
  source: IntegrationProviderCatalogItem["source"];
  connectable?: boolean;
}): IntegrationProviderCatalogItem[] {
  const normalized = args.query?.trim().toLowerCase() ?? "";
  let rows = INTEGRATION_CATALOG.filter(args.filter ?? (() => true));
  if (normalized) {
    rows = rows.filter((entry) => {
      const haystack = `${entry.name} ${entry.summary} ${entry.domain} ${entry.kind}`.toLowerCase();
      return haystack.includes(normalized);
    });
  }
  const offset = args.cursor ? Number.parseInt(args.cursor, 10) : 0;
  const start = Number.isFinite(offset) && offset >= 0 ? offset : 0;
  return rows.slice(start, start + args.limit).map((entry) =>
    catalogEntryToProviderItem(entry, {
      source: args.source,
      connectable: args.connectable ?? false,
    }),
  );
}

export function staticCatalogHasMore(args: {
  query?: string;
  cursor?: string;
  limit: number;
  filter?: (entry: IntegrationCatalogEntry) => boolean;
}): { hasMore: boolean; nextCursor: string | null } {
  const normalized = args.query?.trim().toLowerCase() ?? "";
  let rows = INTEGRATION_CATALOG.filter(args.filter ?? (() => true));
  if (normalized) {
    rows = rows.filter((entry) => {
      const haystack = `${entry.name} ${entry.summary} ${entry.domain} ${entry.kind}`.toLowerCase();
      return haystack.includes(normalized);
    });
  }
  const offset = args.cursor ? Number.parseInt(args.cursor, 10) : 0;
  const start = Number.isFinite(offset) && offset >= 0 ? offset : 0;
  const next = start + args.limit;
  return {
    hasMore: next < rows.length,
    nextCursor: next < rows.length ? String(next) : null,
  };
}
