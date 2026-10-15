# 0001 — Desktop shell: Electron

## Context

Shiba Desktop (macOS) wraps the existing dashboard and adds one-click pairing that runs
`scripts/shiba-local-daemon.mjs` on the user's machine. It must add no ingress surface and no
approval path (`spec/GOAL.md` item 15; invariants D1–D8 in `DESKTOP-PLAN.md` §4).

## Options

- **Electron** — loads the dashboard's DOM unchanged, runs the Node daemon via `utilityProcess`, all TypeScript.
- **Tauri 2** — lost: needs Rust plus a Node sidecar for the daemon, and renders with WebKit on macOS.
- **GPUI** — lost: cannot render the existing DOM dashboard, so it means a full UI rewrite.
- **gpuix** — lost: same rewrite as GPUI, and it is pre-1.0 with one maintainer.

## Decision

Electron, pinned to exact versions (`DESKTOP-PLAN.md` §2, A1). The window loads `<origin>/app/`;
the daemon stays a dependency-free script supervised by the app.

## Consequences

- Bundle size and RAM overhead of a bundled Chromium are accepted.
- TypeScript everywhere; one `tsc` config, no bundler.
- The daemon is reused unchanged (additive hooks only); it stays runnable from the CLI.
