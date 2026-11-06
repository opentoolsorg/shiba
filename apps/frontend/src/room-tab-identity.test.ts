import { afterEach, describe, expect, it, vi } from "vitest";
import { roomTabIdentity } from "./room-tab-identity";

const storedId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
function storage(initial = storedId) {
  const values = new Map([["shiba-room-viewer:lease-v1", initial]]);
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
class BrowserLocks implements Pick<LockManager, "request"> {
  readonly held = new Set<string>();
  calls = 0;
  request<T>(name: string, callback: LockGrantedCallback<T>): Promise<T>;
  request<T>(name: string, options: LockOptions, callback: LockGrantedCallback<T>): Promise<T>;
  request<T>(name: string, options: LockOptions | LockGrantedCallback<T>, callback?: LockGrantedCallback<T>): Promise<T> {
    this.calls++;
    const granted = typeof options === "function" ? options : callback;
    if (!granted) throw new Error("Missing callback");
    if (this.held.has(name)) return Promise.resolve().then(() => granted(null));
    this.held.add(name);
    return Promise.resolve().then(() => granted({ name, mode: "exclusive" })).finally(() => { this.held.delete(name); });
  }
}
const flush = async () => { for (let turn = 0; turn < 6; turn++) await Promise.resolve(); };
afterEach(() => { vi.useRealTimers(); });

describe("live document viewer claims", () => {
  it("rotates a copied legacy unleased nonce even if an old live client holds no browser lock", async () => {
    vi.useFakeTimers();
    const values = new Map([["shiba-room-viewer", storedId]]);
    const copiedStorage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const locks = new BrowserLocks();
    const upgraded = roomTabIdentity({ navigator: { locks }, sessionStorage: copiedStorage }).retain();
    const id = await upgraded.ready;
    expect(id).not.toBe(storedId);
    expect(values.get("shiba-room-viewer")).toBe(storedId);
    expect(values.get("shiba-room-viewer:lease-v1")).toBe(id);
    expect(locks.held.has(`shiba:room-viewer:${id}`)).toBe(true);
    upgraded.release(); vi.runOnlyPendingTimers(); await flush();
  });

  it("separates cloned sessionStorage before use and preserves reload identity only under an exclusive claim", async () => {
    vi.useFakeTimers();
    const locks = new BrowserLocks();
    const firstStorage = storage();
    const first = roomTabIdentity({ navigator: { locks }, sessionStorage: firstStorage }).retain();
    expect(await first.ready).toBe(storedId);
    const clone = roomTabIdentity({ navigator: { locks }, sessionStorage: storage(firstStorage.getItem("shiba-room-viewer:lease-v1")!) }).retain();
    const secondId = await clone.ready;
    expect(secondId).not.toBe(storedId);
    first.release(); vi.runOnlyPendingTimers(); await flush();
    const reloaded = roomTabIdentity({ navigator: { locks }, sessionStorage: firstStorage }).retain();
    expect(await reloaded.ready).toBe(storedId);
    expect(locks.held.size).toBe(2);
    reloaded.release(); clone.release(); vi.runOnlyPendingTimers(); await flush();
    expect(locks.held.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("falls back to independent document UUIDs without locks or storage/channel access", async () => {
    vi.useFakeTimers();
    const first = roomTabIdentity({ navigator: {}, sessionStorage: storage() });
    const a = first.retain(), again = first.retain();
    const b = roomTabIdentity({ navigator: {}, sessionStorage: storage() }).retain();
    expect(a.currentId).toBe(again.currentId);
    expect(await a.ready).not.toBe(storedId);
    expect(await b.ready).not.toBe(await a.ready);
    const blockedStorage = { getItem: () => { throw new Error("Storage denied"); }, setItem: () => { throw new Error("Storage denied"); } };
    const denied = roomTabIdentity({ navigator: { locks: new BrowserLocks() }, sessionStorage: blockedStorage }).retain();
    expect(await denied.ready).toMatch(/^[a-f0-9-]{36}$/);
    a.release(); again.release(); b.release(); denied.release(); vi.runOnlyPendingTimers();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares a pending claim through StrictMode cleanup/reacquire and releases it after the last consumer", async () => {
    vi.useFakeTimers();
    const locks = new BrowserLocks();
    const identity = roomTabIdentity({ navigator: { locks }, sessionStorage: storage() });
    const abandoned = identity.retain(); abandoned.release();
    const committed = identity.retain();
    expect(committed.ready).toBe(abandoned.ready);
    expect(await committed.ready).toBe(storedId);
    vi.runOnlyPendingTimers();
    expect(locks.calls).toBe(1);
    expect(locks.held.size).toBe(1);
    committed.release(); committed.release(); vi.runOnlyPendingTimers(); await flush();
    expect(locks.held.size).toBe(0);
  });

  it("bounds an unavailable lock API and never trusts an unclaimed stored nonce", async () => {
    vi.useFakeTimers();
    const locks = { request: <T>() => new Promise<T>(() => {}) };
    const lease = roomTabIdentity({ navigator: { locks }, sessionStorage: storage() }).retain();
    expect(lease.currentId).toBeNull();
    vi.advanceTimersByTime(200);
    expect(await lease.ready).not.toBe(storedId);
    lease.release(); vi.runOnlyPendingTimers();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases a late lock grant without replacing the fallback nonce or stored identity", async () => {
    vi.useFakeTimers();
    const grants: Array<() => void> = [];
    let held = 0;
    class DelayedLocks implements Pick<LockManager, "request"> {
      request<T>(name: string, callback: LockGrantedCallback<T>): Promise<T>;
      request<T>(name: string, options: LockOptions, callback: LockGrantedCallback<T>): Promise<T>;
      request<T>(name: string, options: LockOptions | LockGrantedCallback<T>, callback?: LockGrantedCallback<T>): Promise<T> {
        const granted = typeof options === "function" ? options : callback;
        if (!granted) throw new Error("Missing callback");
        return new Promise<T>((resolve) => { grants.push(() => {
          held++;
          void Promise.resolve(granted({ name, mode: "exclusive" })).then((value) => { held--; resolve(value); });
        }); });
      }
    }
    const saved = storage();
    const lease = roomTabIdentity({ navigator: { locks: new DelayedLocks() }, sessionStorage: saved }).retain();
    vi.advanceTimersByTime(200);
    const fallback = await lease.ready;
    grants[0]!(); await flush();
    expect(held).toBe(0);
    expect(await lease.ready).toBe(fallback);
    expect(saved.getItem("shiba-room-viewer:lease-v1")).toBe(storedId);
    lease.release(); vi.runOnlyPendingTimers();
  });

  it.each(["throw", "reject"])("uses a fresh nonce when lock access fails by %s", async (failure) => {
    vi.useFakeTimers();
    const locks = { request: <T>() => {
      if (failure === "throw") throw new Error("Lock API unavailable");
      return Promise.reject<T>(new Error("Lock API denied"));
    } };
    const lease = roomTabIdentity({ navigator: { locks }, sessionStorage: storage() }).retain();
    expect(await lease.ready).not.toBe(storedId);
    lease.release(); vi.runOnlyPendingTimers();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rotates before reconnect if another live document claimed an inactive tab's old nonce", async () => {
    vi.useFakeTimers();
    const locks = new BrowserLocks();
    const identity = roomTabIdentity({ navigator: { locks }, sessionStorage: storage() });
    const first = identity.retain(); expect(await first.ready).toBe(storedId);
    first.release(); vi.runOnlyPendingTimers(); await flush();
    const clone = roomTabIdentity({ navigator: { locks }, sessionStorage: storage() }).retain();
    expect(await clone.ready).toBe(storedId);
    const reconnect = identity.retain();
    expect(await reconnect.ready).not.toBe(storedId);
    reconnect.release(); clone.release(); vi.runOnlyPendingTimers(); await flush();
    expect(locks.held.size).toBe(0);
  });
});
