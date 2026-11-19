import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  DRAFT_LIMIT,
  HANDOFF_PATH,
  handoffUrl,
  normalizeDestination,
  REASON_MESSAGES,
  sanitizePageUrl,
} from "../handoff.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => readFileSync(join(root, name), "utf8");

test("sanitizePageUrl keeps scheme, host and path only", () => {
  assert.deepEqual(sanitizePageUrl("https://example.com/docs/intro"), {
    ok: true,
    url: "https://example.com/docs/intro",
  });
  assert.deepEqual(sanitizePageUrl("http://127.0.0.1:5173/threads/"), {
    ok: true,
    url: "http://127.0.0.1:5173/threads/",
  });
  assert.deepEqual(sanitizePageUrl("https://example.com"), {
    ok: true,
    url: "https://example.com/",
  });
});

test("sanitizePageUrl drops query, fragment and credentials", () => {
  assert.equal(
    sanitizePageUrl("https://example.com/a/b?token=secret&q=private#section").url,
    "https://example.com/a/b",
  );
  assert.equal(
    sanitizePageUrl("https://alice:hunter2@example.com/inbox?mail=42").url,
    "https://example.com/inbox",
  );
  assert.equal(sanitizePageUrl("https://example.com/?q=q#f").url, "https://example.com/");
  assert.equal(sanitizePageUrl("  https://example.com/x?y=1  ").url, "https://example.com/x");
});

test("sanitizePageUrl refuses non-web and malformed addresses", () => {
  for (const raw of [
    "chrome://settings",
    "chrome-extension://abc/options.html",
    "file:///etc/passwd",
    "about:blank",
    "view-source:https://example.com",
    "javascript:alert(1)",
    "data:text/html,hi",
    "ftp://example.com/file",
  ]) {
    assert.deepEqual(sanitizePageUrl(raw), { ok: false, reason: "unsupported-address" }, raw);
  }
  for (const raw of ["", "   ", "not a url", "https://", "://example.com", "/just/a/path"]) {
    assert.deepEqual(sanitizePageUrl(raw), { ok: false, reason: "malformed" }, raw);
  }
  assert.deepEqual(sanitizePageUrl(undefined), { ok: false, reason: "malformed" });
  assert.deepEqual(sanitizePageUrl(42), { ok: false, reason: "malformed" });
});

test("normalizeDestination accepts one https origin, or loopback http", () => {
  assert.deepEqual(normalizeDestination("https://shiba.example.com"), {
    ok: true,
    origin: "https://shiba.example.com",
  });
  assert.deepEqual(normalizeDestination("https://shiba.example.com/"), {
    ok: true,
    origin: "https://shiba.example.com",
  });
  assert.deepEqual(normalizeDestination("  https://shiba.example.com:8443  "), {
    ok: true,
    origin: "https://shiba.example.com:8443",
  });
  for (const raw of ["http://localhost:5173", "http://127.0.0.1:5173", "http://[::1]:5173"]) {
    const result = normalizeDestination(raw);
    assert.equal(result.ok, true, raw);
    assert.equal(result.origin, new URL(raw).origin);
  }
});

test("normalizeDestination refuses paths, credentials, plaintext remotes and non-web schemes", () => {
  assert.deepEqual(normalizeDestination("https://shiba.example.com/team"), {
    ok: false,
    reason: "origin-only",
  });
  assert.deepEqual(normalizeDestination("https://shiba.example.com/?tab=work"), {
    ok: false,
    reason: "origin-only",
  });
  assert.deepEqual(normalizeDestination("https://shiba.example.com/#x"), {
    ok: false,
    reason: "origin-only",
  });
  assert.deepEqual(normalizeDestination("https://user:pw@shiba.example.com"), {
    ok: false,
    reason: "credentials-not-allowed",
  });
  assert.deepEqual(normalizeDestination("http://shiba.example.com"), {
    ok: false,
    reason: "insecure-destination",
  });
  assert.deepEqual(normalizeDestination("ftp://shiba.example.com"), {
    ok: false,
    reason: "unsupported-address",
  });
  assert.deepEqual(normalizeDestination("shiba.example.com"), { ok: false, reason: "malformed" });
  assert.deepEqual(normalizeDestination(""), { ok: false, reason: "malformed" });
  assert.deepEqual(normalizeDestination(null), { ok: false, reason: "malformed" });
});

test("handoffUrl builds the dashboard's documented ?prompt= address", () => {
  const url = handoffUrl("https://shiba.example.com", "https://example.com/docs");
  assert.equal(
    url,
    `https://shiba.example.com${HANDOFF_PATH}?prompt=https%3A%2F%2Fexample.com%2Fdocs`,
  );

  const parsed = new URL(url);
  assert.equal(parsed.pathname, "/threads/");
  assert.deepEqual([...parsed.searchParams.keys()], ["prompt"]);
  assert.equal(parsed.searchParams.get("prompt"), "https://example.com/docs");
  assert.equal(parsed.hash, "");
});

test("handoffUrl encodes characters that would otherwise break the address", () => {
  const draft = "Review this & send a summary\n#2 (please)";
  const url = handoffUrl("https://shiba.example.com", draft);
  assert.equal(new URL(url).searchParams.get("prompt"), draft);
  assert.equal(url.includes("#"), false);
  assert.equal(url.slice(url.indexOf("?")).includes("&"), false);
});

test("handoffUrl caps the draft at the dashboard's 4000-character limit", () => {
  const url = handoffUrl("https://shiba.example.com", "x".repeat(DRAFT_LIMIT + 250));
  assert.equal(new URL(url).searchParams.get("prompt").length, DRAFT_LIMIT);
});

test("handoffUrl refuses a blank draft or an invalid destination", () => {
  assert.equal(handoffUrl("https://shiba.example.com", ""), null);
  assert.equal(handoffUrl("https://shiba.example.com", "   \n "), null);
  assert.equal(handoffUrl("https://shiba.example.com", undefined), null);
  assert.equal(handoffUrl("http://shiba.example.com", "https://example.com"), null);
  assert.equal(handoffUrl("https://shiba.example.com/team", "https://example.com"), null);
  assert.equal(handoffUrl(null, "https://example.com"), null);
});

test("every refusal reason has words a person can read", () => {
  for (const reason of [
    "malformed",
    "unsupported-address",
    "no-tab-access",
    "no-destination",
    "credentials-not-allowed",
    "origin-only",
    "insecure-destination",
    "empty-draft",
  ]) {
    assert.equal(typeof REASON_MESSAGES[reason], "string", reason);
    assert.ok(REASON_MESSAGES[reason].length > 0, reason);
  }
});

test("the manifest asks for the two permissions it uses and nothing else", () => {
  const manifest = JSON.parse(read("manifest.json"));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ["activeTab", "storage"]);
  assert.deepEqual(manifest.action.default_popup, "popup.html");
  assert.deepEqual(manifest.options_ui.page, "options.html");

  for (const key of [
    "host_permissions",
    "optional_permissions",
    "optional_host_permissions",
    "content_scripts",
    "background",
    "web_accessible_resources",
    "externally_connectable",
    "declarative_net_request",
    "devtools_page",
    "sandbox",
    "content_security_policy",
    "nativeMessaging",
    "cookies",
  ]) {
    assert.equal(key in manifest, false, `manifest declares ${key}`);
  }
});

test("no script reaches the network, page DOM, other tabs or the filesystem", () => {
  const sources = ["handoff.js", "popup.js", "options.js", "popup.html", "options.html"];
  const forbidden = [
    "fetch(",
    "XMLHttpRequest",
    "sendBeacon",
    "WebSocket",
    "EventSource",
    "import(",
    "chrome.cookies",
    "chrome.scripting",
    "chrome.debugger",
    "chrome.webRequest",
    "executeScript",
    "chrome.runtime.sendMessage",
    "chrome.runtime.connect",
    "chrome.tabs.sendMessage",
    "chrome.storage.sync",
    "chrome.identity",
    "chrome.alarms",
    "chrome.bookmarks",
    "chrome.history",
    "localStorage",
    "/api/",
  ];
  for (const name of sources) {
    const source = read(name);
    for (const token of forbidden) {
      assert.equal(source.includes(token), false, `${name} uses ${token}`);
    }
  }
});

test("only https hand-offs are ever opened, and only from the click handler", () => {
  const popup = read("popup.js");
  const handler = popup.indexOf('openNode.addEventListener("click"');
  const navigate = popup.indexOf("chrome.tabs.create");
  assert.ok(handler > -1, "the popup registers a click handler");
  assert.ok(navigate > handler, "chrome.tabs.create runs inside the click handler");
  assert.equal(popup.split("chrome.tabs.create").length - 1, 1);
  assert.equal(popup.includes("chrome.tabs.update"), false);
  assert.equal(popup.includes("window.open"), false);
  assert.equal(popup.includes("chrome.tabs.query"), true);
});

test("the extension ships no other page or worker script", () => {
  const files = readdirSync(root).filter((name) => name.endsWith(".html") || name.endsWith(".js"));
  assert.deepEqual(files.sort(), [
    "handoff.js",
    "options.html",
    "options.js",
    "popup.html",
    "popup.js",
  ]);
});
