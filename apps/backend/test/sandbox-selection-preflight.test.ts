import { describe, expect, it, beforeEach } from "vitest";
import { missingSandboxFeatures } from "@shiba/shared";
import { resolveSandboxSelection } from "../src/sandbox/selection.js";
import { resetSandboxProviderCache, resolveSandboxProviderForId } from "../src/sandbox/provider.js";
import { assertSandboxCapabilities, DEFAULT_CODING_RUN_FEATURES } from "../src/sandbox/preflight.js";

describe("sandbox selection precedence", () => {
  it("prefers task override over deployment default", async () => {
    const selection = await resolveSandboxSelection(
      { SHIBA_SANDBOX_PROVIDER: "cloudflare", AGENT_AUDIT: undefined } as never,
      { taskProviderId: "docker-local" },
    );
    expect(selection.providerId).toBe("docker-local");
    expect(selection.source).toBe("task");
  });
});

describe("sandbox capability preflight", () => {
  beforeEach(() => resetSandboxProviderCache());

  it("cloudflare satisfies default coding features", () => {
    const provider = resolveSandboxProviderForId({ Sandbox: {} as never } as never, "cloudflare");
    expect(missingSandboxFeatures(provider.capabilities, DEFAULT_CODING_RUN_FEATURES)).toEqual([]);
    expect(() => assertSandboxCapabilities(provider, DEFAULT_CODING_RUN_FEATURES)).not.toThrow();
  });

  it("docker-local fails edgeEgress preflight", () => {
    const provider = resolveSandboxProviderForId(
      { Sandbox: {} as never, SHIBA_SANDBOX_ALLOW_UNENFORCED_EGRESS: "1" } as never,
      "docker-local",
    );
    expect(missingSandboxFeatures(provider.capabilities, DEFAULT_CODING_RUN_FEATURES)).toContain("edgeEgress");
  });
});
