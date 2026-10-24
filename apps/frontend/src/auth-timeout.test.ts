import { describe, expect, it, vi } from "vitest";
import { AUTH_CLIENT_TIMEOUT_MS, AuthTimeoutError, withAuthTimeout } from "./auth-timeout";

describe("withAuthTimeout", () => {
  it("returns the settled value", async () => {
    await expect(withAuthTimeout(Promise.resolve("ok"), 50)).resolves.toBe("ok");
  });

  it("rejects when the call never settles", async () => {
    vi.useFakeTimers();
    try {
      const pending = withAuthTimeout(new Promise(() => {}), AUTH_CLIENT_TIMEOUT_MS);
      const assertion = expect(pending).rejects.toBeInstanceOf(AuthTimeoutError);
      await vi.advanceTimersByTimeAsync(AUTH_CLIENT_TIMEOUT_MS);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
