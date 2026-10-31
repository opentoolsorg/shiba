import type { Env } from "../env.js";
import type { FetchImpl } from "./contracts.js";

export const COMPOSIO_API_V3_BASE = "https://backend.composio.dev/api/v3";
export const COMPOSIO_API_V31_BASE = "https://backend.composio.dev/api/v3.1";

export function composioApiKey(env: Env): string | null {
  const key = env.COMPOSIO_API_KEY?.trim() || env.COMPOSITO_API_KEY?.trim();
  return key ? key : null;
}

export function composioV3Base(env: Env): string {
  const configured = env.COMPOSIO_API_BASE_URL?.trim();
  return configured ? configured.replace(/\/$/, "") : COMPOSIO_API_V3_BASE;
}

export function composioSessionBase(env: Env): string {
  const configured = env.COMPOSIO_SESSION_API_BASE_URL?.trim();
  return configured ? configured.replace(/\/$/, "") : COMPOSIO_API_V31_BASE;
}

export function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export function normalizeSlug(value: string): string {
  return value.trim().toLowerCase();
}

export type ComposioToolkitPage = {
  items: unknown[];
  nextCursor: string | null;
  hasMore: boolean;
};

export function parseComposioToolkitPage(data: unknown, limit: number): ComposioToolkitPage {
  const rows = Array.isArray(data) ? data : ((data as { items?: unknown[] })?.items ?? []);
  const items = Array.isArray(rows) ? rows : [];
  if (Array.isArray(data)) {
    return { items, nextCursor: null, hasMore: items.length >= limit };
  }
  if (typeof data !== "object" || data === null) {
    return { items: [], nextCursor: null, hasMore: false };
  }
  const record = data as Record<string, unknown>;
  const nextCursor = firstString(record.nextCursor, record.next_cursor, record.cursor);
  const hasMoreFlag = record.hasMore ?? record.has_more;
  const hasMore =
    nextCursor !== null
      ? true
      : typeof hasMoreFlag === "boolean"
        ? hasMoreFlag
        : items.length >= limit;
  return { items, nextCursor, hasMore };
}

export async function composioFetchJson(
  fetchImpl: FetchImpl,
  url: URL | string,
  apiKey: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const response = await fetchImpl(url, {
    ...init,
    headers: {
      "x-api-key": apiKey,
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
    signal: init?.signal ?? AbortSignal.timeout(15_000),
  });
  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  return { ok: response.ok, status: response.status, data };
}
