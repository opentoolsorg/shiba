import { describe, expect, it } from "vitest";
import { parseDeepLink } from "../src/deep-link.js";
import { githubPullRequestUrl } from "../src/pull-request.js";

describe("parseDeepLink", () => {
  it("opens dashboard views", () => {
    expect(parseDeepLink("shiba://open/diff")).toEqual({ kind: "view", view: "diff" });
    expect(parseDeepLink("shiba://open/tasks")).toEqual({ kind: "view", view: "tasks" });
    expect(parseDeepLink("shiba://open/memory")).toEqual({ kind: "view", view: "memory" });
    expect(parseDeepLink("shiba://open/projects")).toEqual({ kind: "view", view: "projects" });
    expect(parseDeepLink("shiba://open/settings")).toEqual({ kind: "view", view: "settings" });
  });

  it("rejects unknown views and other schemes", () => {
    expect(parseDeepLink("shiba://open/not-a-view")).toBeNull();
    expect(parseDeepLink("https://app.tryshiba.dev/app/")).toBeNull();
  });

  it("accepts a github pull link and drops its query", () => {
    expect(
      parseDeepLink(
        "shiba://pr?url=https%3A%2F%2Fgithub.com%2Facme%2Fwidgets%2Fpull%2F12%3Fdiff%3D1",
      ),
    ).toEqual({
      kind: "pull-request",
      url: "https://github.com/acme/widgets/pull/12",
    });
  });

  it("ignores the retired native auth route", () => {
    // Sign-in never comes back through a loopback receiver, so no link may submit one.
    const callback = "http://127.0.0.1:1455/auth/callback?code=abc&state=state-state";
    expect(
      parseDeepLink(`shiba://auth/codex?callback=${encodeURIComponent(callback)}`),
    ).toBeNull();
  });
});

describe("githubPullRequestUrl", () => {
  it("rejects non-pull github URLs", () => {
    expect(githubPullRequestUrl("https://github.com/acme/widgets")).toBeNull();
    expect(githubPullRequestUrl("https://user:token@github.com/acme/widgets/pull/1")).toBeNull();
    expect(githubPullRequestUrl("http://github.com/acme/widgets/pull/1")).toBeNull();
  });
});
