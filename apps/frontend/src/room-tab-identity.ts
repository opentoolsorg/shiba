// Older clients never held a browser lock; their nonce cannot be safely reused
// while an already-open old tab might still own it during an upgrade.
const STORAGE_KEY = "shiba-room-viewer:lease-v1";
const CLAIM_TIMEOUT_MS = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function freshId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (slot) => {
    const value = Math.floor(Math.random() * 16);
    return (slot === "x" ? value : (value & 3) | 8).toString(16);
  });
}

interface TabEnvironment {
  readonly sessionStorage: Pick<Storage, "getItem" | "setItem">;
  readonly navigator: { readonly locks?: Pick<LockManager, "request"> };
}

/** A viewer nonce identifies a live document, never an authenticated person. */
class RoomTabIdentity {
  readonly provisionalId = freshId();
  private id: string | null = null;
  private users = 0;
  private generation = 0;
  private ready: Promise<string> | null = null;
  private releaseLock: (() => void) | null = null;
  private claimTimer: ReturnType<typeof setTimeout> | null = null;
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly environment: TabEnvironment) {}

  retain() {
    this.users++;
    if (this.releaseTimer !== null) clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
    if (!this.ready) this.claim();
    let released = false;
    return {
      currentId: this.id,
      ready: this.ready!,
      release: () => {
        if (released) return;
        released = true;
        this.users--;
        if (this.users === 0) this.releaseTimer = setTimeout(() => this.dispose(), 0);
      },
    };
  }

  private claim() {
    const generation = ++this.generation;
    let resolve!: (id: string) => void;
    this.ready = new Promise<string>((done) => { resolve = done; });
    const accept = (id: string) => {
      if (generation !== this.generation || this.id !== null) return false;
      if (this.claimTimer !== null) clearTimeout(this.claimTimer);
      this.claimTimer = null;
      this.id = id;
      resolve(id);
      return true;
    };
    const fallback = () => { accept(freshId()); };
    let locks: Pick<LockManager, "request"> | undefined;
    let candidate = this.provisionalId;
    try {
      locks = this.environment.navigator.locks;
      if (!locks) { fallback(); return; }
      const stored = this.environment.sessionStorage.getItem(STORAGE_KEY);
      if (stored && UUID.test(stored)) candidate = stored;
    } catch { fallback(); return; }

    // Exclusive browser locks also work when a peer tab's JS is suspended.
    // A bounded BroadcastChannel probe cannot safely prove that no peer exists.
    this.claimTimer = setTimeout(fallback, CLAIM_TIMEOUT_MS);
    const manager = locks;
    const request = (id: string, retry: boolean) => {
      try {
        void manager.request(`shiba:room-viewer:${id}`, { ifAvailable: true }, (lock) => {
          if (generation !== this.generation || this.id !== null) return;
          if (!lock) {
            if (retry) request(freshId(), false);
            else fallback();
            return;
          }
          if (!accept(id)) return;
          try { this.environment.sessionStorage.setItem(STORAGE_KEY, id); } catch { /* Storage is optional. */ }
          return new Promise<void>((release) => { this.releaseLock = release; });
        }).catch(fallback);
      } catch { fallback(); }
    };
    request(candidate, true);
  }

  private dispose() {
    if (this.users !== 0) return;
    this.generation++;
    if (this.claimTimer !== null) clearTimeout(this.claimTimer);
    this.claimTimer = null;
    this.releaseTimer = null;
    this.releaseLock?.();
    this.releaseLock = null;
    this.id = null;
    this.ready = null;
  }
}

const documents = new WeakMap<TabEnvironment, RoomTabIdentity>();

/** Share a claim across hooks/StrictMode in one document, not cloned sessionStorage. */
export function roomTabIdentity(environment: TabEnvironment | undefined = typeof window === "undefined" ? undefined : window) {
  if (!environment) return new RoomTabIdentity({ navigator: {}, sessionStorage: { getItem: () => null, setItem: () => {} } });
  let identity = documents.get(environment);
  if (!identity) { identity = new RoomTabIdentity(environment); documents.set(environment, identity); }
  return identity;
}
