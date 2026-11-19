/**
 * Bounds on the privileged IPC surface: a global concurrency ceiling per
 * registered surface, and single-flight labels so a second invoke cannot spawn
 * a second native process. Electron-free.
 */

export const MAX_CONCURRENT_IPC = 8;

export const IPC_BUSY_ERROR = "Too many pending Shiba Desktop requests.";

export interface IpcBounds {
  /** Runs `work` while the surface has capacity, else returns `whenBusy()`. */
  run<T>(work: () => Promise<T>, whenBusy: () => T): Promise<T>;
  /** Takes a single-flight label; false means a call already holds it. */
  tryEnter(label: string): boolean;
  leave(label: string): void;
  active(): number;
}

export function createIpcBounds(maxConcurrent = MAX_CONCURRENT_IPC): IpcBounds {
  let active = 0;
  const held = new Set<string>();
  return {
    active: () => active,
    tryEnter(label) {
      if (held.has(label)) return false;
      held.add(label);
      return true;
    },
    leave(label) {
      held.delete(label);
    },
    async run(work, whenBusy) {
      if (active >= maxConcurrent) return whenBusy();
      active += 1;
      try {
        return await work();
      } finally {
        active -= 1;
      }
    },
  };
}
