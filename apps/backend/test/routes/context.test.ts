import { expect, it, vi } from "vitest";
import type { Env } from "../../src/env.js";
import * as auth from "../../src/request-auth.js";
import { createRequestContext } from "../../src/routes/context.js";

it("resolves identity lazily once per request context, including concurrent consumers", async () => {
  const resolve = vi.spyOn(auth, "resolveUserId").mockResolvedValue("user@example.test");
  try {
    const env = {} as Env;
    const context = createRequestContext(new Request("https://example.test/oauth/authorize"), env);
    expect(resolve).not.toHaveBeenCalled();
    expect(await Promise.all([context.identity(), context.identity()])).toEqual([
      "user@example.test",
      "user@example.test",
    ]);
    expect(resolve).toHaveBeenCalledTimes(1);
    const next = createRequestContext(new Request("https://example.test/oauth/authorize"), env);
    await next.identity();
    expect(resolve).toHaveBeenCalledTimes(2);
  } finally {
    resolve.mockRestore();
  }
});
