# `apps/backend`

The Cloudflare Worker: API, static host, Durable Objects, sandbox control,
egress proxy. There is deliberately no `build` task — wrangler bundles TS at
deploy. Root `AGENTS.md` (tradeoffs) and `CLAUDE.md` (gate) apply first.

## Where things live

- `src/index.ts` — the router: authenticate per surface, then dispatch. A new
  ingress surface authenticates by its own mechanism; it never inherits
  another surface's auth.
- `src/*-do.ts` — Durable Object classes: orchestrator, per-run sandbox
  control, automations, mailbox, memory, `BrowserSession`, `ComputerSession`,
  `ChatGptAuth`. A new stateful thing = a new DO + a new `new_sqlite_classes`
  migration tag in `wrangler.jsonc` **and** `alchemy.run.ts`. Tags are
  append-only.
- `src/harness/` — one transport plus a shim per agent CLI. A new harness
  touches `harness/catalog.ts`, `HARNESS_DEFAULT_MODELS`, egress hosts, and
  the image Dockerfile.
- `src/tools/` — agent tools (browser, media, search). `tools/browser*` is
  documented in `docs/architecture/browser.md`.
- `src/sandbox/` — sandbox lifecycle, egress proxy, preview proxy.
  `screen-control.ts` and `computer-session.ts` are documented in
  `docs/architecture/computer-use.md`.

## Rules that cost you if skipped

- Everything typed that crosses a package boundary lives in
  `packages/shared` — not here, not in the frontend.
- Real credentials never reach this file's callers' containers: the egress
  proxy attaches them; the sandbox sees `shiba-egress-placeholder`.
- `env.ts` + `worker-secrets.json` own env var names; add vars there, in
  `wrangler.jsonc` vars, and in alchemy config — then `pnpm check:deploy`.
- Domain ownership is mapped file-by-file in `docs/SOURCE-LAYOUT.md`; a new
  file gets a row there.

## Computer use / browser use — where to read before editing

- Human-in-the-loop browser: `docs/architecture/browser.md`, code in
  `src/tools/browser-*.ts`.
- Cloud computer + shared desktop + preview links:
  `docs/architecture/computer-use.md`, code in `src/screen-control.ts`,
  `src/computer-session.ts`, `src/shared-computer-*.ts`,
  `src/sandbox/preview-*.ts`.
