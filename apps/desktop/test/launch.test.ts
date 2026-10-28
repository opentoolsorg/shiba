import { describe, expect, it } from "vitest";
import { dashboardPath, HOSTED_ORIGIN, resolveConfiguredOrigin } from "../src/launch.js";
import { parseDeploymentUrl } from "../src/navigation.js";

const parse = parseDeploymentUrl;

describe("resolveConfiguredOrigin", () => {
  it.each([
    { envUrl: "", forceSetup: false },
    { envUrl: "http://127.0.0.1:8788", forceSetup: true },
    { envUrl: "http://127.0.0.1:8788", forceSetup: false },
  ])("honors an interactive setup selection over launch hints %j", (hint) => {
    expect(resolveConfiguredOrigin({
      packaged: false, ...hint, savedUrl: undefined,
      sessionUrl: "http://localhost:9012/app/", parse,
    })).toBe("http://localhost:9012");
  });

  it("keeps packaged URL restrictions on interactive selections", () => {
    expect(resolveConfiguredOrigin({
      packaged: true, envUrl: undefined, forceSetup: false,
      savedUrl: "https://existing.example", sessionUrl: "http://localhost:9012", parse,
    })).toBe("");
  });

  it("uses the hosted product when nothing is saved", () => {
    expect(
      resolveConfiguredOrigin({
        packaged: true,
        envUrl: "http://127.0.0.1:9",
        forceSetup: false,
        savedUrl: undefined,
        parse,
      }),
    ).toBe(HOSTED_ORIGIN);
  });

  it("lets an unpackaged env URL override the hosted product", () => {
    expect(
      resolveConfiguredOrigin({
        packaged: false,
        envUrl: "http://127.0.0.1:8788/app",
        forceSetup: false,
        savedUrl: undefined,
        parse,
      }),
    ).toBe("http://127.0.0.1:8788");
  });

  it("opens setup for an explicit empty env or the setup flag", () => {
    expect(
      resolveConfiguredOrigin({
        packaged: false,
        envUrl: "",
        forceSetup: false,
        savedUrl: undefined,
        parse,
      }),
    ).toBe("");
    expect(
      resolveConfiguredOrigin({
        packaged: false,
        envUrl: "http://127.0.0.1:8788",
        forceSetup: true,
        savedUrl: undefined,
        parse,
      }),
    ).toBe("");
  });

  it("keeps a saved https origin", () => {
    expect(
      resolveConfiguredOrigin({
        packaged: true,
        envUrl: undefined,
        forceSetup: false,
        savedUrl: "https://shiba.example.com/app",
        parse,
      }),
    ).toBe("https://shiba.example.com");
  });
});

describe("dashboardPath", () => {
  it("maps shell views onto dashboard tabs", () => {
    expect(dashboardPath("tasks")).toBe("/app/");
    expect(dashboardPath("diff")).toBe("/app/?tab=diff");
    expect(dashboardPath("approvals")).toBe("/app/?tab=approvals");
    expect(dashboardPath("remote")).toBe("/app/?tab=remote");
  });
});
