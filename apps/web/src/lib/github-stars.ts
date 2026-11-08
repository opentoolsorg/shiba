// Public metadata only: never attach an installation or user token here.
export const GITHUB_REPOSITORY_URL = 'https://github.com/opentoolsorg/shiba';
const API_URL = 'https://api.github.com/repos/opentoolsorg/shiba';
const CACHE_KEY = 'shiba:github-stars:v1';
const FRESH_FOR_MS = 15 * 60 * 1000;
const KEEP_FOR_MS = 24 * 60 * 60 * 1000;
const RETRY_AFTER_MS = 5 * 60 * 1000;

type Cache = { count: number | null; checkedAt: number; retryAt: number };
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
type StarCount = { count: number; checkedAt: number; stale: boolean };

type Options = {
  fetcher?: typeof fetch;
  storage?: StorageLike;
  now?: () => number;
  timeoutMs?: number;
};

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function readCache(storage: StorageLike | undefined, now: number): Cache | null {
  try {
    const value = JSON.parse(storage?.getItem(CACHE_KEY) ?? 'null') as Partial<Cache> | null;
    if (
      !value || (value.count !== null && !isCount(value.count)) ||
      typeof value.checkedAt !== 'number' || !Number.isFinite(value.checkedAt) ||
      value.checkedAt < 0 || value.checkedAt > now ||
      typeof value.retryAt !== 'number' || !Number.isFinite(value.retryAt) ||
      value.retryAt < 0 || value.retryAt > now + RETRY_AFTER_MS
    ) return null;
    return value as Cache;
  } catch {
    return null;
  }
}

function saveCache(storage: StorageLike | undefined, cache: Cache) {
  try { storage?.setItem(CACHE_KEY, JSON.stringify(cache)); } catch { /* Storage can be blocked. */ }
}

/** Fetch at runtime, cache successful reads for 15 minutes, and back off after failures. */
export async function loadGitHubStars({
  fetcher = fetch, storage, now = Date.now, timeoutMs = 4000,
}: Options = {}): Promise<StarCount | null> {
  const startedAt = now();
  const cache = readCache(storage, startedAt);
  const cachedCount = cache && cache.count !== null && startedAt - cache.checkedAt < KEEP_FOR_MS
    ? { count: cache.count, checkedAt: cache.checkedAt, stale: startedAt - cache.checkedAt >= FRESH_FOR_MS }
    : null;
  if (cachedCount && !cachedCount.stale) return cachedCount;
  if (cache && cache.retryAt > startedAt) return cachedCount;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(API_URL, {
      headers: { Accept: 'application/vnd.github+json' },
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error('GitHub metadata unavailable');
    const data: unknown = await response.json();
    if (!data || typeof data !== 'object' || !('stargazers_count' in data) || !isCount(data.stargazers_count)) {
      throw new Error('Invalid GitHub star count');
    }
    const result = { count: data.stargazers_count, checkedAt: now(), stale: false };
    saveCache(storage, { count: result.count, checkedAt: result.checkedAt, retryAt: 0 });
    return result;
  } catch {
    saveCache(storage, {
      count: cachedCount?.count ?? null,
      checkedAt: cachedCount?.checkedAt ?? 0,
      retryAt: now() + RETRY_AFTER_MS,
    });
    return cachedCount;
  } finally {
    clearTimeout(timeout);
  }
}

export function formatGitHubStars(count: number): string {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(count);
}

export async function initGitHubStars(link: HTMLAnchorElement): Promise<void> {
  const count = link.querySelector<HTMLElement>('[data-github-stars-count]');
  if (!count) return;
  let storage: StorageLike | undefined;
  try { storage = window.localStorage; } catch { /* Private browsing can deny access. */ }
  const result = await loadGitHubStars({ storage });
  if (!result) return; // Keep the useful, accessible GitHub link when offline or rate-limited.
  count.textContent = formatGitHubStars(result.count);
  const exact = result.count.toLocaleString('en');
  const label = `Shiba on GitHub, ${exact} ${result.count === 1 ? 'star' : 'stars'}`;
  const checked = new Date(result.checkedAt).toLocaleString('en');
  link.setAttribute('aria-label', `${label}${result.stale ? ', last known count' : ''}`);
  link.title = `${label}. ${result.stale ? 'Last known count; ' : ''}Checked ${checked}.`;
}
