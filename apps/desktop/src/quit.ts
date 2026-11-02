interface QuitEvent {
  preventDefault(): void;
}

/** Keep every quit attempt blocked until the daemon and shell finish cleanup. */
export function createQuitHandler(options: {
  confirm(): boolean;
  stop(): Promise<void>;
  cleanup(): void;
  quit(): void;
  onError(error: unknown): void;
}): (event: QuitEvent) => void {
  let stopping = false;
  let complete = false;
  return (event) => {
    if (complete) return;
    event.preventDefault();
    if (stopping || !options.confirm()) return;
    stopping = true;
    void Promise.resolve().then(options.stop).catch(options.onError).finally(() => {
      try {
        options.cleanup();
      } finally {
        complete = true;
        options.quit();
      }
    });
  };
}
