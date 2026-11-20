/**
 * Unpacked-extension handoff in a real Chrome, against synthetic pages.
 *
 * Chrome cannot be told by a script to click its own toolbar. The harness
 * therefore proves the boundary twice: with no action invocation the popup
 * refuses to read the tab at all, and with the single browser call a click
 * unlocks (`chrome.tabs.query`) stubbed, the real popup code turns a synthetic
 * page address into the dashboard's `?prompt=` handoff. The dashboard here is a
 * local stub mirroring the documented contract: prefill, strip, never send.
 *
 * Nothing in this run can create a Shiba run, approval or provider call; the
 * assertions check that the only requests made were the popup's own files and
 * one dashboard navigation.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { REASON_MESSAGES } from "../handoff.js";

const extensionDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const chromeFlag = process.argv.find((argument) => argument.startsWith("--chrome="));
const chromePath = chromeFlag
  ? chromeFlag.slice("--chrome=".length)
  : "/usr/local/bin/google-chrome";

if (!existsSync(chromePath)) {
  console.log(`skipped: no Chrome at ${chromePath}; pass --chrome=<path> to run this check`);
  process.exit(0);
}

const checks = [];
function check(name, condition, detail = "") {
  const ok = Boolean(condition);
  checks.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || detail === "" ? "" : ` — ${detail}`}`);
}

const pageHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>Synthetic article</title></head>
<body><h1>Synthetic article</h1><p>Local fixture. No account data is read.</p></body></html>`;

const dashboardHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>Synthetic Shiba dashboard</title></head>
<body>
<main>
  <h1>Synthetic Shiba dashboard</h1>
  <label>Task request <textarea id="composer" rows="6"></textarea></label>
  <button id="send" type="button">Send</button>
  <p>Sent: <span id="sent">0</span></p>
</main>
<script>
  // Mirror of the dashboard contract (apps/frontend/src/ui-helpers.ts):
  // prefill from ?prompt=, strip it from the address, never submit.
  const params = new URLSearchParams(location.search);
  const prompt = params.get("prompt");
  if (prompt !== null) {
    document.getElementById("composer").value = prompt.slice(0, 4000);
    params.delete("prompt");
    const next = params.toString();
    history.replaceState(history.state, "", location.pathname + (next ? "?" + next : "") + location.hash);
  }
  let sent = 0;
  document.getElementById("send").addEventListener("click", () => {
    sent += 1;
    document.getElementById("sent").textContent = String(sent);
    fetch("/api/runs", { method: "POST", body: "{}" });
  });
  window.__dashboardStub = { sent: () => sent, composer: () => document.getElementById("composer").value };
</script>
</body></html>`;

const requests = [];
const server = createServer((request, response) => {
  const address = new URL(request.url, "http://127.0.0.1");
  requests.push({ method: request.method, path: address.pathname, search: address.search });
  if (request.method === "GET" && address.pathname === "/page") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(pageHtml);
    return;
  }
  if (request.method === "GET" && address.pathname === "/threads/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(dashboardHtml);
    return;
  }
  if (address.pathname === "/api/runs") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
    return;
  }
  response.writeHead(404, { "content-type": "text/plain" });
  response.end("not found");
});

const listen = () =>
  new Promise((done) => server.listen(0, "127.0.0.1", () => done(server.address().port)));

async function waitFor(predicate, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((done) => setTimeout(done, 100));
  }
}

function connect(webSocketUrl, onEvent = () => {}) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  let nextId = 0;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method) onEvent(message);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  });
  const ready = new Promise((done, fail) => {
    socket.addEventListener("open", () => done(), { once: true });
    socket.addEventListener("error", fail, { once: true });
  });
  return {
    ready,
    send(method, params = {}) {
      const id = ++nextId;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((done, fail) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          fail(new Error(`no response to ${method}`));
        }, 10_000);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            done(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            fail(error);
          },
        });
      });
    },
    close: () => socket.close(),
  };
}

async function listTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  return response.json();
}

async function openTarget(port, url) {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
    method: "PUT",
  });
  return response.json();
}

async function pageClient(port, targetId, onEvent) {
  const target = await waitFor(
    async () => (await listTargets(port)).find((entry) => entry.id === targetId),
    "a page target",
  );
  const client = connect(target.webSocketDebuggerUrl, onEvent);
  await client.ready;
  await client.send("Runtime.enable");
  await client.send("Page.enable");
  return client;
}

async function evaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? "evaluation failed");
  }
  return result.result.value;
}

const profileDir = mkdtempSync(join(tmpdir(), "shiba-extension-"));
let chrome;
const clients = [];

try {
  const origin = `http://127.0.0.1:${await listen()}`;
  chrome = spawn(
    chromePath,
    [
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`,
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  let chromeLog = "";
  chrome.stdout.on("data", (chunk) => (chromeLog += chunk));
  chrome.stderr.on("data", (chunk) => (chromeLog += chunk));

  const devtoolsPort = await waitFor(() => {
    const file = join(profileDir, "DevToolsActivePort");
    if (!existsSync(file)) return null;
    const value = Number.parseInt(readFileSync(file, "utf8").split("\n")[0], 10);
    return Number.isFinite(value) && value > 0 ? value : null;
  }, "the DevTools endpoint");

  // Chrome loads the unpacked folder itself and reports the id it assigned, so
  // the run proves the folder validates as an extension rather than assuming it.
  const versionResponse = await fetch(`http://127.0.0.1:${devtoolsPort}/json/version`);
  const version = await versionResponse.json();
  const browser = connect(version.webSocketDebuggerUrl);
  await browser.ready;
  clients.push(browser);
  const loaded = await browser.send("Extensions.loadUnpacked", { path: extensionDir });
  const extensionId = loaded.id;
  const popupUrl = `chrome-extension://${extensionId}/popup.html`;
  check(
    "Chrome accepts the folder as an unpacked extension",
    typeof extensionId === "string" && extensionId.length === 32,
    String(extensionId),
  );

  // 1. The unpacked extension loads and its popup runs in its own origin.
  const probeTarget = await openTarget(devtoolsPort, popupUrl);
  const probe = await pageClient(devtoolsPort, probeTarget.id);
  clients.push(probe);
  const popupTitle = await waitFor(
    () => evaluate(probe, "document.title || null").catch(() => null),
    "the popup document",
  );
  check("the unpacked extension loads in Chrome", popupTitle === "Shiba draft", String(popupTitle));
  check(
    "the popup runs in the extension origin",
    (await evaluate(probe, "chrome.runtime.getManifest().name")) === "Shiba draft handoff",
  );

  // 2. With no destination stored, the popup offers nothing to open.
  const noDestination = await waitFor(async () => {
    const text = await evaluate(probe, "document.querySelector('#notice').textContent");
    return text || null;
  }, "the destination notice");
  check(
    "a missing destination is reported before anything else",
    noDestination === REASON_MESSAGES["no-destination"],
    noDestination,
  );
  check(
    "the open button stays hidden without a destination",
    (await evaluate(probe, "document.querySelector('#open').hidden")) === true,
  );

  // 3. The options page refuses an address that is not one https origin.
  const optionsTarget = await openTarget(
    devtoolsPort,
    `chrome-extension://${extensionId}/options.html`,
  );
  const options = await pageClient(devtoolsPort, optionsTarget.id);
  clients.push(options);
  await waitFor(
    async () => (await evaluate(options, "document.readyState")) === "complete",
    "the options page",
  );
  const saveAddress = async (value) => {
    await evaluate(
      options,
      `(() => {
        document.querySelector("#destination").value = ${JSON.stringify(value)};
        document.querySelector("#form").requestSubmit();
      })()`,
    );
    await new Promise((done) => setTimeout(done, 200));
    return evaluate(
      options,
      `({ status: document.querySelector("#status").textContent,
          tone: document.querySelector("#status").dataset.tone ?? null })`,
    );
  };

  const remoteHttp = await saveAddress("http://shiba.example.com");
  check(
    "a plaintext remote destination is refused",
    remoteHttp.tone === "error" && remoteHttp.status === REASON_MESSAGES["insecure-destination"],
    JSON.stringify(remoteHttp),
  );
  const withPath = await saveAddress("https://shiba.example.com/team?tab=work");
  check(
    "a destination with a path or query is refused rather than trimmed",
    withPath.tone === "error" && withPath.status === REASON_MESSAGES["origin-only"],
    JSON.stringify(withPath),
  );
  const withCredentials = await saveAddress("https://alice:secret@shiba.example.com");
  check(
    "a destination carrying credentials is refused",
    withCredentials.tone === "error" &&
      withCredentials.status === REASON_MESSAGES["credentials-not-allowed"],
    JSON.stringify(withCredentials),
  );
  const storedAfterRefusals = await evaluate(
    options,
    "(async () => JSON.stringify(await chrome.storage.local.get(null)))()",
  );
  check("refused addresses were not stored", storedAfterRefusals === "{}", storedAfterRefusals);

  const saved = await saveAddress(origin);
  check(
    "a loopback origin for local development is accepted",
    saved.tone === "ok" && saved.status === `Saved ${origin}`,
    JSON.stringify(saved),
  );

  // 4. A stored destination alone still does not unlock a tab address. Chrome
  // hands an extension the address of its own pages and withholds every other
  // tab's address until the person invokes the action.
  await evaluate(probe, "location.reload()");
  const withheld = await evaluate(
    probe,
    `(async () => (await chrome.tabs.query({})).map((tab) => ({
      own: tab.url?.startsWith("chrome-extension://${extensionId}/") ?? false,
      url: tab.url === undefined,
    })))()`,
  );
  check(
    "Chrome withholds every other tab's address without the action grant",
    withheld.length > 0 && withheld.every((tab) => tab.own || tab.url === true),
    JSON.stringify(withheld),
  );
  const ownPageRefusal = await waitFor(
    () => evaluate(probe, "document.querySelector('#notice').textContent"),
    "the popup after reload",
  );
  check(
    "a non-web address the popup can see is refused",
    ownPageRefusal === REASON_MESSAGES["unsupported-address"],
    ownPageRefusal,
  );
  check(
    "no page address is shown without a usable tab address",
    (await evaluate(probe, "document.querySelector('#page').hidden")) === true,
  );

  // 4b. The withheld shape itself drives the real code path: a tab record with
  // no address, exactly what Chrome returns before the action is invoked.
  const withheldTarget = await openTarget(devtoolsPort, "about:blank");
  const withheldPopup = await pageClient(devtoolsPort, withheldTarget.id);
  clients.push(withheldPopup);
  await withheldPopup.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      const query = async () => [{}];
      try {
        chrome.tabs.query = query;
      } catch {
        Object.defineProperty(chrome, "tabs", { value: { query }, configurable: true });
      }
    })();`,
  });
  await withheldPopup.send("Page.navigate", { url: popupUrl });
  const withheldNotice = await waitFor(
    () =>
      evaluate(withheldPopup, "document.querySelector('#notice').textContent").then((text) =>
        text === REASON_MESSAGES["no-tab-access"] ? text : null,
      ),
    "the withheld-address notice",
  );
  check(
    "a tab Chrome withholds the address of is reported, not guessed",
    withheldNotice === REASON_MESSAGES["no-tab-access"],
    withheldNotice,
  );
  check(
    "the open button stays hidden for a withheld address",
    (await evaluate(withheldPopup, "document.querySelector('#open').hidden")) === true,
  );

  // 5. The handoff. The synthetic page address carries credentials, a query and
  // a fragment, all of which must be gone from what Chrome is asked to open.
  const syntheticPage = `${origin.replace("http://", "http://reader:hunter2@")}/page?token=synthetic-secret&mail=42#section-2`;
  const handoffTarget = await openTarget(devtoolsPort, "about:blank");
  const popupRequests = [];
  const handoff = await pageClient(devtoolsPort, handoffTarget.id, (message) => {
    if (message.method === "Network.requestWillBeSent") {
      popupRequests.push(message.params.request.url);
    }
  });
  clients.push(handoff);
  await handoff.send("Network.enable");
  // The stub stands in for the one browser call a toolbar click unlocks; every
  // line of extension code after it runs unmodified.
  await handoff.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      const query = async () => [{ url: ${JSON.stringify(syntheticPage)} }];
      try {
        chrome.tabs.query = query;
      } catch {
        Object.defineProperty(chrome, "tabs", { value: { query }, configurable: true });
      }
    })();`,
  });
  await handoff.send("Page.navigate", { url: popupUrl });
  await waitFor(
    async () => (await evaluate(handoff, "document.title")) === "Shiba draft",
    "the popup",
  );
  check(
    "the stub replaced the browser call under test, not the extension code",
    (await evaluate(
      handoff,
      "(async () => (await chrome.tabs.query({ active: true }))[0].url)()",
    )) === syntheticPage,
  );

  const expectedPage = `${origin}/page`;
  const previewed = await waitFor(async () => {
    const text = await evaluate(handoff, "document.querySelector('#page').textContent");
    return text || null;
  }, "the sanitized address");
  check("the preview keeps only scheme, host and path", previewed === expectedPage, previewed);
  check(
    "the draft starts as the sanitized address",
    (await evaluate(handoff, "document.querySelector('#draft').value")) === expectedPage,
  );

  const editedDraft = `${expectedPage}\nSummarise this page and draft a reply & keep it short.`;
  await evaluate(
    handoff,
    `(() => {
      const draft = document.querySelector("#draft");
      draft.value = ${JSON.stringify(editedDraft)};
      draft.dispatchEvent(new Event("input", { bubbles: true }));
    })()`,
  );
  check(
    "the draft stays editable before the handoff",
    (await evaluate(handoff, "document.querySelector('#draft').value")) === editedDraft,
  );
  check(
    "nothing reaches the dashboard before the click",
    requests.filter((entry) => entry.path === "/threads/").length === 0,
  );
  // The popup closes itself after opening the tab, so its traffic is read here.
  check(
    "the popup fetched only the extension's own files",
    popupRequests.length > 0 &&
      popupRequests.every((url) => url.startsWith(`chrome-extension://${extensionId}/`)),
    popupRequests.join(", "),
  );

  const beforeClick = requests.length;
  await evaluate(handoff, `document.querySelector("#open").click()`);

  const dashboardTarget = await waitFor(
    async () =>
      (await listTargets(devtoolsPort)).find(
        (entry) => entry.type === "page" && entry.url.startsWith(`${origin}/threads/`),
      ),
    "the dashboard tab",
  );
  const dashboard = await pageClient(devtoolsPort, dashboardTarget.id);
  clients.push(dashboard);
  const dashboardState = await waitFor(
    () =>
      evaluate(
        dashboard,
        `({ composer: window.__dashboardStub.composer(),
            sent: window.__dashboardStub.sent(),
            search: location.search,
            hash: location.hash })`,
      ).catch(() => null),
    "the dashboard to prefill",
  );
  check(
    "the dashboard composer holds the edited draft, unsent",
    dashboardState.composer === editedDraft && dashboardState.sent === 0,
    JSON.stringify(dashboardState),
  );
  check(
    "the draft parameter is stripped from the dashboard address",
    dashboardState.search === "" && dashboardState.hash === "",
    JSON.stringify(dashboardState),
  );
  check(
    "the dashboard composer is editable after landing",
    await evaluate(
      dashboard,
      `(() => {
        const composer = document.querySelector("#composer");
        return !composer.readOnly && !composer.disabled && composer.isContentEditable === false;
      })()`,
    ),
  );

  const handoffs = requests.filter((entry) => entry.path === "/threads/");
  check(
    "the handoff is one GET to /threads/ carrying the draft",
    handoffs.length === 1 &&
      handoffs[0].method === "GET" &&
      handoffs[0].search === `?prompt=${encodeURIComponent(editedDraft)}`,
    JSON.stringify(handoffs),
  );
  check(
    "the page query, fragment and credentials never leave the browser",
    !JSON.stringify(requests).includes("synthetic-secret") &&
      !JSON.stringify(requests).includes("hunter2") &&
      !JSON.stringify(requests).includes("section-2"),
    JSON.stringify(requests),
  );
  const afterClick = requests.slice(beforeClick).filter((entry) => entry.path !== "/favicon.ico");
  check(
    "the click produced no run, approval or provider request",
    afterClick.length === 1 && afterClick[0].method === "GET" && afterClick[0].path === "/threads/",
    JSON.stringify(afterClick),
  );
  check(
    "no /api/ request was made at all",
    requests.every((entry) => !entry.path.startsWith("/api/")),
    JSON.stringify(requests.filter((entry) => entry.path.startsWith("/api/"))),
  );

  // 6. The manifest Chrome loaded carries no broader grant.
  const granted = JSON.parse(
    await evaluate(
      probe,
      `(async () => JSON.stringify({
        permissions: chrome.runtime.getManifest().permissions,
        origins: (await chrome.permissions.getAll()).origins ?? [],
      }))()`,
    ),
  );
  check(
    "Chrome granted only activeTab and storage",
    JSON.stringify(granted.permissions) === JSON.stringify(["activeTab", "storage"]),
    JSON.stringify(granted),
  );
  check("no host permission is granted", granted.origins.length === 0, JSON.stringify(granted));

  if (checks.some((entry) => !entry.ok))
    console.log(`\nChrome log tail:\n${chromeLog.slice(-1500)}`);
} catch (error) {
  check("the run completed", false, error instanceof Error ? (error.stack ?? "") : String(error));
} finally {
  for (const client of clients) client.close();
  try {
    if (chrome?.pid) process.kill(-chrome.pid, "SIGKILL");
  } catch {
    // Chrome already exited.
  }
  server.close();
  rmSync(profileDir, { recursive: true, force: true });
}

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length > 0 ? 1 : 0);
