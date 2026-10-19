import { describe, expect, it } from "vitest";
import type { EgressEnv } from "../src/egress.js";
import { defaultOutboundConfig } from "../src/sandbox/outbound-config.js";
import { dispatchOutboundRequest } from "../src/sandbox/outbound-dispatch.js";

const env = { GITHUB_TOKEN: "ghp-test" } as unknown as EgressEnv;

describe("dispatchOutboundRequest", () => {
  it("denies hosts outside allowedHosts", async () => {
    const config = defaultOutboundConfig();
    config.allowedHosts = ["github.com"];
    const res = await dispatchOutboundRequest(
      new Request("https://api.anthropic.com/v1/messages"),
      env,
      config,
    );
    expect(res.status).toBe(403);
  });

  it("routes github through scoped handler after approveRepoScope", async () => {
    const config = defaultOutboundConfig();
    config.allowedHosts = ["github.com"];
    config.outboundByHost["github.com"] = {
      kind: "named",
      handler: "githubScoped",
      params: { allowedPath: "/acme/widgets" },
    };
    const res = await dispatchOutboundRequest(
      new Request("https://github.com/acme/other.git/info/refs"),
      env,
      config,
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("outside the approved scope");
  });
});
