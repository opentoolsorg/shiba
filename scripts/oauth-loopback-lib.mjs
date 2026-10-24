/**
 * Local OAuth loopback listeners for Antigravity (51121) and xAI (56121).
 * Browser redirects post back to the dashboard via window.opener.postMessage.
 */
import { createServer } from "node:http";

export const SHIBA_OAUTH_CALLBACK_MESSAGE = "shiba-oauth-callback";

/** @type {readonly { port: number; pathname: string }[]} */
export const OAUTH_LOOPBACK_BINDINGS = [
  { port: 51121, pathname: "/callback" },
  { port: 56121, pathname: "/callback" },
];

/**
 * @param {string} callbackUrl
 * @returns {string}
 */
export function oauthCallbackSuccessHtml(callbackUrl) {
  const safe = JSON.stringify(callbackUrl);
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"/><title>Shiba sign-in</title></head>
<body>
<p>Sign-in complete. Return to the Shiba dashboard — this tab can close.</p>
<script>
(function () {
  var url = ${safe};
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage({ type: ${JSON.stringify(SHIBA_OAUTH_CALLBACK_MESSAGE)}, url: url }, "*");
    }
  } catch (e) {}
})();
</script>
</body>
</html>`;
}

/**
 * @param {{ port: number; pathname?: string; onHit?: (url: string) => void }} opts
 * @returns {import("node:http").Server}
 */
export function startOAuthLoopbackServer({ port, pathname = "/callback", onHit } = {}) {
  const server = createServer((req, res) => {
    const host = req.headers.host ?? `127.0.0.1:${port}`;
    const pathOnly = (req.url ?? "/").split("?")[0] ?? "/";
    if (pathOnly !== pathname) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    const callbackUrl = `http://${host}${req.url ?? ""}`;
    onHit?.(callbackUrl);
    const body = oauthCallbackSuccessHtml(callbackUrl);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
  });
  server.listen(port, "127.0.0.1");
  return server;
}

/**
 * @param {{ onListen?: (port: number) => void; onHit?: (url: string) => void }} [opts]
 * @returns {import("node:http").Server[]}
 */
export function startAllOAuthLoopbackServers(opts = {}) {
  return OAUTH_LOOPBACK_BINDINGS.map(({ port, pathname }) => {
    const server = startOAuthLoopbackServer({
      port,
      pathname,
      onHit: opts.onHit,
    });
    server.on("listening", () => opts.onListen?.(port));
    return server;
  });
}
