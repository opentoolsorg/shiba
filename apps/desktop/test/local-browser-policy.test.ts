import { describe, expect, it } from "vitest";
import { nativeWindowAvailability, parseLocalBrowserAddress } from "../src/local-browser-policy.js";

describe("local browser address policy", () => {
  it("accepts only complete http(s) URLs without embedded credentials", () => {
    expect(parseLocalBrowserAddress("http://127.0.0.1:5173/test")).toMatchObject({
      origin: "http://127.0.0.1:5173",
    });
    expect(parseLocalBrowserAddress("https://EXAMPLE.org/path")).toMatchObject({
      origin: "https://example.org",
    });
    for (const value of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,secret",
      "https://user:password@example.org/",
      "https://example.org/\n",
      `https://example.org/${"x".repeat(2048)}`,
    ]) {
      expect(parseLocalBrowserAddress(value)).toBeNull();
    }
    expect(parseLocalBrowserAddress(undefined)).toBeNull();
  });

  it("fails closed for native window control without a verified OS provider", () => {
    expect(nativeWindowAvailability({ platform: "linux", display: ":0" })).toMatchObject({
      available: false,
      reason: expect.stringContaining("Linux/X11"),
    });
    expect(nativeWindowAvailability({ platform: "darwin" })).toMatchObject({
      available: false,
      reason: expect.stringContaining("no verified OS-scoped"),
    });
  });
});
