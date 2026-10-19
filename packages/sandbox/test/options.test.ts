import { describe, expect, it } from "vitest";
import { parseSandboxProviderConfig, type CloudflareProviderOptions } from "../src/options.js";

describe("parseSandboxProviderConfig", () => {
  it("applies defaults for cloudflare", () => {
    const parsed = parseSandboxProviderConfig({}, "cloudflare");
    expect(parsed.id).toBe("cloudflare");
    const opts = parsed.options as CloudflareProviderOptions;
    expect(opts.instanceType).toBe("standard-1");
    expect(opts.timeoutMs).toBe(900_000);
  });

  it("parses egress allowlist", () => {
    const parsed = parseSandboxProviderConfig(
      { SHIBA_SANDBOX_EGRESS_ALLOWLIST: "api.example.com, github.com" },
      "cloudflare",
    );
    if (parsed.id === "cloudflare") {
      expect(parsed.options.egressAllowlist).toEqual(["api.example.com", "github.com"]);
    }
  });
});
