import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const layout = readFileSync(new URL('../src/layouts/MarketingPage.astro', import.meta.url), 'utf8');
const script = layout.match(/<script is:inline>\s*([\s\S]*?)\s*<\/script>/)?.[1];
assert.ok(script, 'MarketingPage has its pre-paint theme initializer');

test('marketing theme sync follows shared preference, system mode, and external updates', () => {
  const root = { dataset: {} as Record<string, string>, classList: { add() {} }, setAttribute(name: string, value: string) { this.dataset[name] = value; } };
  const handlers = new Map<string, (event?: unknown) => void>();
  const buttonHandlers = new Map<string, (event?: unknown) => void>();
  const values = new Map([['shiba-theme', 'light']]);
  let cookie = 'shiba-theme=dark';
  let systemDark = false;
  let systemChange: (() => void) | undefined;
  const button = { hidden: true, attrs: {} as Record<string, string>, setAttribute(name: string, value: string) { this.attrs[name] = value; }, addEventListener(name: string, callback: (event?: unknown) => void) { buttonHandlers.set(name, callback); } };
  const document = {
    documentElement: root,
    get cookie() { return cookie; },
    set cookie(value: string) { cookie = value.split(';')[0]; },
    querySelectorAll() { return []; },
    getElementById() { return button; },
    addEventListener(name: string, callback: (event?: unknown) => void) { handlers.set(name, callback); },
  };
  const window = { addEventListener(name: string, callback: (event?: unknown) => void) { handlers.set(name, callback); } };
  const context = vm.createContext({ document, window, location: { hostname: 'app.tryshiba.dev', protocol: 'https:' }, localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) }, matchMedia: () => ({ get matches() { return systemDark; }, addEventListener(_name: string, callback: () => void) { systemChange = callback; } }) });

  vm.runInContext(script, context);
  assert.equal(root.dataset.theme, 'dark', 'shared cookie wins over stale local storage');
  assert.equal(values.get('shiba-theme'), 'dark');

  handlers.get('DOMContentLoaded')?.();
  buttonHandlers.get('click')?.();
  assert.equal(cookie, 'shiba-theme=system', 'site switch can return to system preference');
  systemDark = true;
  systemChange?.();
  assert.equal(root.dataset.theme, 'dark', 'system preference follows OS mode');

  cookie = 'shiba-theme=light';
  handlers.get('focus')?.();
  assert.equal(root.dataset.theme, 'light', 'focus adopts a preference selected on another subdomain');
  assert.equal(values.get('shiba-theme'), 'light');
});
