/** Dashboard auth calls must settle. A hung Worker left the button on "Working…" forever. */
export const AUTH_CLIENT_TIMEOUT_MS = 15_000;

export class AuthTimeoutError extends Error {
  constructor() {
    super("The auth service did not answer in time. Nothing was confirmed. Try again.");
    this.name = "AuthTimeoutError";
  }
}

export async function withAuthTimeout<T>(work: Promise<T>, ms = AUTH_CLIENT_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AuthTimeoutError()), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
