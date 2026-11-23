# Browser use

Shiba's browser tool is a Cloudflare Browser Rendering session driven through
one Durable Object per session. The agent never touches the page directly —
it sends named commands; the DO is the only owner of the `Page`.

## Pieces

- `src/tools/browser-session-do.ts` — `BrowserSession`, the DO. Holds one
  puppeteer `Browser`/`Page` pair, serializes every command through a single
  promise chain (`this.pending`), and enforces two deadlines: sessions idle
  out after 3 minutes (`IDLE_MS`), a human sign-in approval after 2
  (`APPROVAL_MS`). Viewport is fixed at 1000×700.
- `src/tools/browser.ts`, `browser-sessions.ts` — the tool surface: command
  schemas (`BrowserCommand`) and the registry from name → DO stub.
- `src/tools/browser-routes.ts` — HTTP routes for dashboard panel operations.
- `src/tools/browser-url.ts` — `assertPublicBrowserUrl`, the SSRF guard: only
  public http(s) origins; private/link-local IPs are refused before any
  navigation *and* re-checked on every read of `page.url()` (`pageUrl`), so a
  redirect cannot smuggle the agent onto an internal host.
- `src/tools/browser-logins.ts`, `browser-sign-in.ts` — the human sign-in
  flow. An agent can ask a person to log in on a site: the request mints an
  approval (`browserLoginIntent`); only after a human acts does the DO mark
  the session `signedIn` with the code consumed exactly once.

## Take-over (human in the loop)

`controller` on the session records who drives. When a person takes over,
agent commands return `PAUSED` ("a person is controlling the browser") —
including screenshots, so the model cannot see what the human types.
Hand-back clears the controller and the agent resumes. There is no merging
of control: one driver at a time.

## What the model sees

`displayUrl` deliberately hides information: before sign-in the model gets
`origin + pathname` (query strings may carry secrets); after a signed-in
session it gets `origin` only. `redactBrowserLoginOutput` strips credential
material from any tool result. Screenshots are delivered as bounded image
bytes through the same serial queue.

## Local desktop browser (operator-only)

The Electron app also has an isolated Local Browser window for visible,
operator-triggered actions. Its bundled local UI is a separate trusted
surface; it does not add local-control authority to `window.shibaDesktop` or
the remote dashboard. The operator approves one exact `http(s)` origin. Each
approval gets a fresh non-persistent Electron session; stop, window close,
target change, and app quit revoke control and clear that session's cookies,
cache, and storage. Browser permissions, pop-ups, downloads, cross-origin
requests, and cross-origin navigation are denied.

The only app-issued page action is clicking one visible, enabled `<button>` by
its exact visible or accessible label. The app does not read page text or
screenshots, inspect form values, type into the page, or import saved logins.
Take-over pauses app-issued actions until the operator hands control back.
This local window currently has no task-agent/MCP bridge; its action field is
operated directly from the trusted local UI. Native-window capture/input is
unavailable unless a verified OS-scoped provider is added; global input tools
are not a fallback.

## Frontend

`apps/frontend/src/components/BrowserPanel.tsx` renders the live frame and
the take-over / release controls. It talks to `browser-routes.ts`, never to
the agent's tool path — the human channel and the agent channel are separate.

## Rules for changes

- Every new command goes through `BrowserCommand` and the serial queue; never
  hand a `Page` to two callers.
- Keep `assertPublicBrowserUrl` on every path that produces a navigation or
  a URL read.
- Any output the model can read must pass through the display/redact
  helpers — the sign-in wall is meaningless if a URL leaks the token.
