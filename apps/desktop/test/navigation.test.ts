import { describe, expect, it } from "vitest";
import {
  decideNavigation,
  externalHandoffUrl,
  isSafeAppPath,
  isSetupSender,
  isSubframeNavigationAllowed,
  isTrustedSender,
  parseDeploymentUrl,
} from "../src/navigation.js";

const ORIGIN = "https://shiba.example.com";

describe("parseDeploymentUrl", () => {
  const cases: Array<[string, string, boolean, string | null]> = [
    ["https reduced to origin", "https://shiba.example.com/app/?x=1#y", true, ORIGIN],
    ["whitespace trimmed", "  https://shiba.example.com  ", true, ORIGIN],
    ["https port kept", "https://shiba.example.com:8443/a", true, "https://shiba.example.com:8443"],
    ["http remote rejected", "http://shiba.example.com", false, null],
    ["http localhost dev", "http://localhost:5173/app", false, "http://localhost:5173"],
    ["http 127.0.0.1 dev", "http://127.0.0.1:8788", false, "http://127.0.0.1:8788"],
    ["http localhost packaged rejected", "http://localhost:5173", true, null],
    ["http lookalike host rejected", "http://localhost.evil.com", false, null],
    ["credentials rejected", "https://user:pw@shiba.example.com", true, null],
    ["file rejected", "file:///etc/passwd", false, null],
    ["javascript rejected", "javascript:alert(1)", false, null],
    ["garbage rejected", "not a url", true, null],
    ["empty rejected", "", true, null],
  ];
  it.each(cases)("%s", (_n, input, packaged, expected) => {
    expect(parseDeploymentUrl(input, packaged)).toBe(expected);
  });
});

describe("decideNavigation", () => {
  const cases: Array<[string, string, "allow" | "external" | "deny"]> = [
    ["configured origin", `${ORIGIN}/app/`, "allow"],
    ["configured origin other path", `${ORIGIN}/api/x?y=1`, "allow"],
    ["credentials on configured origin", "https://user:secret@shiba.example.com/app/", "deny"],
    ["credentials on external origin", "https://user:secret@example.org/", "deny"],
    ["credentials on auth host", "https://user:secret@accounts.google.com/", "deny"],
    [
      "cloudflareaccess team host",
      "https://acme.cloudflareaccess.com/cdn-cgi/access/login",
      "allow",
    ],
    ["cloudflareaccess lookalike", "https://cloudflareaccess.com.evil.com/", "external"],
    ["cloudflareaccess suffix trick", "https://evilcloudflareaccess.com/", "external"],
    ["cloudflareaccess over http", "http://acme.cloudflareaccess.com/", "deny"],
    ["google auth host", "https://accounts.google.com/o/oauth2/v2/auth", "allow"],
    ["Slack OpenID authorization", "https://slack.com/openid/connect/authorize", "allow"],
    ["Slack unrelated page -> external", "https://slack.com/workspace", "external"],
    ["github login prefix", "https://github.com/login/oauth/authorize", "allow"],
    ["github login exact", "https://github.com/login", "allow"],
    ["github session", "https://github.com/session", "allow"],
    ["github other path -> external", "https://github.com/anthropics/x", "external"],
    ["github loginx not a prefix", "https://github.com/loginx", "external"],
    ["microsoft login", "https://login.microsoftonline.com/common/oauth2", "allow"],
    ["other https -> external", "https://example.org/docs", "external"],
    ["different port on origin host -> external", "https://shiba.example.com:8443/", "external"],
    ["http on origin host -> deny", "http://shiba.example.com/", "deny"],
    ["file -> deny", "file:///etc/passwd", "deny"],
    ["javascript -> deny", "javascript:alert(1)", "deny"],
    ["data -> deny", "data:text/html,hi", "deny"],
    ["custom scheme -> deny", "vscode://open", "deny"],
    ["garbage -> deny", "::::", "deny"],
  ];
  it.each(cases)("%s", (_n, url, expected) => {
    expect(decideNavigation(url, ORIGIN)).toBe(expected);
  });

  it("allows a dev loopback origin only when configured", () => {
    expect(decideNavigation("http://localhost:5173/app", "http://localhost:5173")).toBe("allow");
    expect(decideNavigation("http://localhost:5173/app", ORIGIN)).toBe("deny");
  });

  it("honours custom authHosts instead of the defaults", () => {
    expect(decideNavigation("https://idp.corp.com/sso", ORIGIN, ["idp.corp.com"])).toBe("allow");
    expect(decideNavigation("https://accounts.google.com/", ORIGIN, ["idp.corp.com"])).toBe(
      "external",
    );
  });

  it("treats an unset origin as matching nothing", () => {
    expect(decideNavigation("https://shiba.example.com/", "")).toBe("external");
  });
});

describe("isTrustedSender", () => {
  it.each([
    [`${ORIGIN}/app/`, ORIGIN, true],
    [`${ORIGIN}/`, ORIGIN, true],
    ["https://evil.com/", ORIGIN, false],
    ["https://shiba.example.com.evil.com/", ORIGIN, false],
    ["http://shiba.example.com/", ORIGIN, false],
    ["file:///app/setup.html", ORIGIN, false],
    ["", ORIGIN, false],
    [undefined, ORIGIN, false],
    [`${ORIGIN}/`, "", false],
    ["about:blank", ORIGIN, false],
  ])("%s vs %s -> %s", (frame, origin, expected) => {
    expect(isTrustedSender(frame, origin)).toBe(expected);
  });
});

describe("isSetupSender", () => {
  const setup = "file:///Applications/Shiba.app/Contents/Resources/app/dist/setup.html";
  it("accepts the bundled setup page, with query/hash", () => {
    expect(isSetupSender(`${setup}?error=x#y`, setup)).toBe(true);
  });
  it.each(["file:///tmp/evil.html", `${ORIGIN}/dist/setup.html`, "", undefined])(
    "rejects %s",
    (frame) => {
      expect(isSetupSender(frame, setup)).toBe(false);
    },
  );
});

describe("externalHandoffUrl", () => {
  it("returns a normalized https link for the OS browser", () => {
    // A fragment can be part of a sign-in response; the OS browser keeps it.
    expect(externalHandoffUrl("https://example.org/docs?x=1#top", ORIGIN)).toBe(
      "https://example.org/docs?x=1#top",
    );
    expect(externalHandoffUrl("https://user:pw@example.org/#frag", ORIGIN)).toBeNull();
  });

  it("never hands over the app origin, an auth hop, or a non-https url", () => {
    expect(externalHandoffUrl(`${ORIGIN}/app/`, ORIGIN)).toBeNull();
    expect(externalHandoffUrl("https://accounts.google.com/o/oauth2/auth", ORIGIN)).toBeNull();
    expect(externalHandoffUrl("http://example.org/", ORIGIN)).toBeNull();
    expect(externalHandoffUrl("file:///etc/passwd", ORIGIN)).toBeNull();
    expect(externalHandoffUrl("https://user:pw@example.org/", ORIGIN)).toBeNull();
    expect(externalHandoffUrl(`https://example.org/${"a".repeat(2100)}`, ORIGIN)).toBeNull();
    expect(externalHandoffUrl("", ORIGIN)).toBeNull();
  });
});

describe("isSubframeNavigationAllowed", () => {
  it("keeps frames on the app origin", () => {
    expect(isSubframeNavigationAllowed(`${ORIGIN}/artifact?id=1`, ORIGIN)).toBe(true);
    expect(isSubframeNavigationAllowed("https://evil.example/", ORIGIN)).toBe(false);
    expect(isSubframeNavigationAllowed("file:///etc/passwd", ORIGIN)).toBe(false);
    expect(isSubframeNavigationAllowed("https://user:pw@" + "shiba.example.com/", ORIGIN)).toBe(
      false,
    );
    expect(isSubframeNavigationAllowed(`${ORIGIN}/`, "")).toBe(false);
  });
});

describe("isSafeAppPath", () => {
  it.each([
    ["/app/", true],
    ["/app/?tab=activity", true],
    ["/app/?tab=approvals", true],
    ["/app/?tab=settings", true],
    ["/memory/", true],
    ["/projects/", true],
    ["/outputs/", true],
    ["/unknown/", false],
    ["/app/?tab=activity&run=1", false],
    ["/memory/?x=1", false],
    ["/app/../etc/passwd", false],
    ["https://evil.example/app/", false],
    ["//evil.example/app/", false],
    ["/app/?tab=activity\nSet-Cookie: x", false],
    ["", false],
    [`/app/?tab=${"a".repeat(300)}`, false],
  ])("%s -> %s", (value, expected) => {
    expect(isSafeAppPath(value)).toBe(expected);
  });
});
