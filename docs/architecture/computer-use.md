# Computer use

Shiba has two kinds of "computer" an agent or a person can drive. They share
one input pipeline.

## Cloud computer (run-scoped sandbox desktop)

A coding run may provision a desktop inside its Sandbox container: Xvfb on
`DISPLAY=:1`, a browser, and the `shiba-run-computer` agent binary baked into
the image. The composer offers "Cloud computer"; the approval card freezes
that choice with the run's inputs, so the sandbox image, the egress allowlist
and the desktop flag are approved together.

`src/screen-control.ts` is the input pipeline — the only way input reaches
the display:

- Five actions: `click` (integer coords inside 1280×800), `type`
  (≤ 4000 chars), `scroll` (bounded deltas and tick count), `key`
  (≤ 16 chorded keys), `shot` (screenshot, ≤ 500 KB base64 frame).
- Each action validates to argv before it can run; argv goes through
  `scopedExec` with a hardcoded allowlist — `shiba-run-computer action` and
  `shiba-run-computer control` only. No path from a model's text to a shell.
- Frames come back through `SCREEN_INTAKE_PREFIX`-tagged output
  (`screen:<base64 png>`), emitted to the run event stream that the
  frontend's computer panel renders.
- Human take-over / release works like the browser tool's: while a person
  holds control, agent input is refused and frames stop reaching the model.

The sandbox image must actually contain `shiba-run-computer` — deployments
pin an image tag in `wrangler.jsonc` / `wrangler.dogfood.jsonc`, and an image
that predates the binary fails the desktop at start. When the image changes,
pin the new tag in both.

## Shared computer (persistent desktop)

`src/computer-session.ts` — `ComputerSession`, a DO that owns exactly one
offline desktop container and is *never* attached to a coding run. The
container is verified on every operation: `inspect()` must show the contract
image and the `purpose=offline-desktop` + `session=<id>` labels, else the DO
refuses with `shared_computer_container_identity_changed`. Commands execute
with a deadline (`#deadline`), capped process output (4 KB), and
`HOME=/home/desktop`, `PATH=/usr/bin:/bin` — a deliberately tiny env.
Operations are minted once (`computer_once` SQL table) and verified by
`verifyComputerOperation` in `shared-computer-auth.ts`; limits live in
`SHARED_COMPUTER_LIMITS` in `@shiba/shared`.

## Preview links

`sandbox/preview-proxy.ts` serves sandbox-exposed ports on tokenized
hostnames (`{port}-{sandboxId}-{token}.{workerHost}`); the token is a 16-byte
random value minted per run (`mintPreviewToken`), so a preview URL is itself
a capability. `preview-bridge.ts` rewrites asset URLs in served HTML so SPA
previews keep working behind the proxy.

## Rules for changes

- New input kinds go through `ScreenAction` validation → `scopedExec`; never
  widen the allowlist to a generic shell.
- A frame is output, not authority: it is rendered to the user and fed to the
  model as an image; it never becomes a command argument unvalidated.
- Retire/retake paths run through `shared-computer-store.ts`
  (`assertComputerCurrent`, generation checks) so a stale D1 row cannot
  reattach someone else's container.
