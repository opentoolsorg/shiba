import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extensionsApi } from "./extensions-api";

beforeEach(() => extensionsApi.resetStubFixtures());
afterEach(() => { extensionsApi.resetStubFixtures(); vi.unstubAllGlobals(); });

describe("extensions API normal HTTP failures", () => {
  it.each([401, 403, 404, 500])("rejects HTTP %s without inventing connected accounts", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Backend refused request" }, { status })));
    await expect(extensionsApi.listConnectors("personal")).rejects.toMatchObject({ message: "Backend refused request" });
  });
  it("propagates network errors without falling back to fixtures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Network unavailable"); }));
    await expect(extensionsApi.listConnectors("personal")).rejects.toMatchObject({ message: "Network unavailable" });
  });
  it("rejects successful non-JSON responses instead of inventing accounts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>Sign in</html>", { status: 200 })));
    await expect(extensionsApi.listConnectors("personal")).rejects.toMatchObject({ message: "Invalid extensions API response" });
  });
});
