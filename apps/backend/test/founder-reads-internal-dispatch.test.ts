// Internal test: reaches past founder/reads/index.ts because the origin pin is unreachable from the interface (every request URL is built by an adapter from validated input, so an outer check always refuses first).
import { expect, it, vi } from "vitest";
import { dispatchReadRequest } from "../src/founder/reads/dispatch.js";

it("refuses a provider URL pinned to the other provider's origin", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  try {
    await expect(dispatchReadRequest({
      url: "https://graph.facebook.com/v25.0/act_123",
      method: "GET",
      headers: {},
    }, Date.now() + 60_000, "hubspot")).rejects.toThrow("hubspot_request_unconfirmed");
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
