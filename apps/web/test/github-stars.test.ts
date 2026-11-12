import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { formatGitHubStars, GITHUB_REPOSITORY_URL, initGitHubStars, loadGitHubStars } from '../src/lib/github-stars.ts';

const minute = 60_000;
const now = 1_800_000_000_000;
const cacheKey = 'shiba:github-stars:v1';
function storageWith(value?: unknown) {
  const entries = new Map<string, string>();
  if (value !== undefined) entries.set(cacheKey, JSON.stringify(value));
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, item: string) => { entries.set(key, item); },
  };
}
const success = (count: unknown): typeof fetch => async () => new Response(JSON.stringify({ stargazers_count: count }));
const offline: typeof fetch = async () => { throw new TypeError('Offline'); };

test('requests the canonical public repository at runtime without credentials or a referrer', async () => {
  const storage = storageWith();
  const fetcher: typeof fetch = async (url, options) => {
    assert.equal(url, 'https://api.github.com/repos/opentoolsorg/shiba');
    assert.equal(options?.credentials, 'omit');
    assert.equal(options?.referrerPolicy, 'no-referrer');
    assert.deepEqual(options?.headers, { Accept: 'application/vnd.github+json' });
    assert.ok(options?.signal);
    return new Response(JSON.stringify({ stargazers_count: 1234 }));
  };
  assert.equal(GITHUB_REPOSITORY_URL, 'https://github.com/opentoolsorg/shiba');
  assert.deepEqual(await loadGitHubStars({ fetcher, storage, now: () => now }), { count: 1234, checkedAt: now, stale: false });
  assert.deepEqual(JSON.parse(storage.getItem(cacheKey) ?? ''), { count: 1234, checkedAt: now, retryAt: 0 });
});

test('reuses a fresh cache without a network call, including a real zero', async () => {
  for (const count of [0, 1234]) {
    const storage = storageWith({ count, checkedAt: now - minute, retryAt: 0 });
    const fetcher: typeof fetch = async () => { assert.fail('Fresh metadata should not be refetched'); };
    assert.deepEqual(await loadGitHubStars({ fetcher, storage, now: () => now }), { count, checkedAt: now - minute, stale: false });
  }
});

test('refreshes at the 15-minute cache boundary and records decreases too', async () => {
  const storage = storageWith({ count: 200, checkedAt: now - 15 * minute, retryAt: 0 });
  assert.deepEqual(await loadGitHubStars({ fetcher: success(199), storage, now: () => now }), { count: 199, checkedAt: now, stale: false });
});

test('keeps a bounded, explicitly stale count on failure and backs off across page loads', async () => {
  for (const status of [403, 429, 500]) {
    let calls = 0;
    const storage = storageWith({ count: 120, checkedAt: now - 20 * minute, retryAt: 0 });
    const fetcher: typeof fetch = async () => { calls++; return new Response('', { status }); };
    const expected = { count: 120, checkedAt: now - 20 * minute, stale: true };
    assert.deepEqual(await loadGitHubStars({ fetcher, storage, now: () => now }), expected);
    assert.deepEqual(await loadGitHubStars({ fetcher, storage, now: () => now + minute }), expected);
    assert.equal(calls, 1);
    await loadGitHubStars({ fetcher, storage, now: () => now + 5 * minute });
    assert.equal(calls, 2, 'retry resumes after the cooldown');
  }
});

test('an offline first visit has no invented number and still observes cooldown', async () => {
  const storage = storageWith();
  assert.equal(await loadGitHubStars({ fetcher: offline, storage, now: () => now }), null);
  assert.equal(await loadGitHubStars({ fetcher: success(10), storage, now: () => now + minute }), null);
  assert.equal((await loadGitHubStars({ fetcher: success(10), storage, now: () => now + 5 * minute }))?.count, 10);
});

test('does not show cached counts older than 24 hours', async () => {
  const storage = storageWith({ count: 120, checkedAt: now - 24 * 60 * minute, retryAt: 0 });
  assert.equal(await loadGitHubStars({ fetcher: offline, storage, now: () => now }), null);
});

test('ignores malformed, future-dated, and unsafe cached values', async () => {
  const invalid = [
    {}, null, [],
    { count: -1, checkedAt: now, retryAt: 0 },
    { count: '20', checkedAt: now, retryAt: 0 },
    { count: 1.1, checkedAt: now, retryAt: 0 },
    { count: Number.MAX_SAFE_INTEGER + 1, checkedAt: now, retryAt: 0 },
    { count: 20, checkedAt: now + minute, retryAt: 0 },
    { count: 20, checkedAt: -1, retryAt: 0 },
    { count: 20, checkedAt: now, retryAt: now + 60 * minute },
  ];
  for (const value of invalid) {
    assert.equal((await loadGitHubStars({ fetcher: success(40), storage: storageWith(value), now: () => now }))?.count, 40);
  }
  const storage = storageWith();
  storage.setItem(cacheKey, '{invalid JSON');
  assert.equal((await loadGitHubStars({ fetcher: success(40), storage, now: () => now }))?.count, 40);
});

test('rejects malformed API data instead of presenting false star counts', async () => {
  for (const count of [-1, 1.5, '200', null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(await loadGitHubStars({ fetcher: success(count), now: () => now }), null);
  }
  const fetcher: typeof fetch = async () => new Response('not JSON');
  assert.equal(await loadGitHubStars({ fetcher, now: () => now }), null);
});

test('works without storage and when browser storage throws', async () => {
  const storage = {
    getItem: () => { throw new Error('SecurityError'); },
    setItem: () => { throw new Error('QuotaExceededError'); },
  };
  assert.equal((await loadGitHubStars({ fetcher: success(3), storage, now: () => now }))?.count, 3);
  assert.equal((await loadGitHubStars({ fetcher: success(4), now: () => now }))?.count, 4);
});

test('aborts a slow request and preserves the fallback', async () => {
  let aborted = false;
  const fetcher: typeof fetch = async (_url, options) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('Aborted')); });
  });
  assert.equal(await loadGitHubStars({ fetcher, timeoutMs: 5, now: () => now }), null);
  assert.ok(aborted);
});

test('formats large numbers compactly without confusing zero with missing data', () => {
  assert.equal(formatGitHubStars(0), '0');
  assert.equal(formatGitHubStars(999), '999');
  assert.equal(formatGitHubStars(1234), '1.2K');
  assert.equal(formatGitHubStars(1234567), '1.2M');
});

test('updates the accessible name with an exact count and marks stale fallback honestly', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousFetch = globalThis.fetch;
  const count = { textContent: 'Star' };
  const attributes = new Map<string, string>();
  const link = {
    querySelector: () => count,
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    title: '',
  };
  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: storageWith({ count: 1234, checkedAt: Date.now() - 20 * minute, retryAt: 0 }) } });
    globalThis.fetch = offline;
    await initGitHubStars(link as unknown as HTMLAnchorElement);
    assert.equal(count.textContent, '1.2K');
    assert.equal(attributes.get('aria-label'), 'Shiba on GitHub, 1,234 stars, last known count');
    assert.match(link.title, /Last known count; Checked/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('header replaces only the self-host CTA and has a meaningful no-JavaScript fallback', () => {
  const layout = readFileSync(new URL('../src/layouts/MarketingPage.astro', import.meta.url), 'utf8');
  const header = layout.split('<header')[1]?.split('</header>')[0] ?? '';
  assert.match(header, /<GitHubStars\s*\/>/);
  assert.doesNotMatch(header, /Self-host|self-hosting/);
  assert.match(layout, /href="\/docs\/self-hosting\/"/);
  const component = readFileSync(new URL('../src/components/GitHubStars.astro', import.meta.url), 'utf8');
  assert.match(component, /aria-label="Star Shiba on GitHub"/);
  assert.match(component, /data-github-stars-count>Star<\/span>/);
  assert.match(component, /min-height: 44px/);
  assert.match(component, /:focus-visible/);
  assert.doesNotMatch(component, /target="_blank"/);
});
