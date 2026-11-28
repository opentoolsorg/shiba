# `apps/frontend`

Root `AGENTS.md` applies first; this file adds local rules.

The React dashboard (Vite + TanStack Router, served by the Worker at `/app`).
It renders; it does not call provider APIs — the Worker proxies everything,
so no credential reaches this bundle.

## Where things live

- `src/components/` — the views; a new view registers in `AppNavRail.tsx`
  and is backed by an authenticated route in `apps/backend/src/index.ts`.
- `src/icons.tsx` — the icon shim: every `lucide-react` import is aliased
  here via `resolve.alias` in `vite.config.ts`; glyphs are Hugeicons. Add a
  mapping here, never a new icon library.
- `src/styles.css` — canonical color tokens (`--paper`, `--card`, `--ink`,
  `--navy`). Read `design.md` before adding any color; never invent a third
  name for an existing one.
- `BrowserPanel.tsx` / computer panel components — human take-over and live
  frames; the human channel (`browser-routes.ts`) is separate from the
  agent's tool path. See `docs/architecture/browser.md`.

## Rules

- Visual polish goes through `.agents/skills/shiba-ui-polish/` guidance:
  smallest useful change, keep identity tokens, label icon-only controls,
  ≥44px targets.
- Shared types come from `@shiba/shared` (`workspace:*`); do not import
  `apps/backend` source.
