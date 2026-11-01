---
title: Remote access setup reference
description: Operator configuration, command-line pairing, and local desktop troubleshooting.
---

This page is for the person setting up Shiba or diagnosing a connected computer. To pair an already configured installation, use the [Remote access guide](/docs/remote-access/).

## Turn it on

Remote Access is off by default. The `/api/local/*` and `/api/computers*` routes return `404` until both of these are true:

- `SHIBA_LOCAL_RUNTIME=1` is set on the Worker.
- The `LocalDispatch` Durable Object is bound.

Pairing tokens are signed with `PAIRING_SECRET`. If that is unset, the Worker signs with `LOCAL_ADAPTER_TOKEN` instead. If neither is set, minting a pairing token returns `503`. With Remote Access off, the dashboard's Remote Access view says the local runtime is disabled.

### Cloudflare Access

Alchemy deploys create a second Access application (`MachineBypass`) that covers `/api/local/*` and the other machine-caller routes with a `bypass` policy, because a daemon cannot complete an interactive Access login — it authenticates inside the Worker with its adapter bearer. If you deploy with wrangler or front the Worker with your own Access configuration, create the equivalent yourself: an Access application on `<worker-host>/api/local/*` with a `bypass` / `everyone` policy. Without it the daemon's polls get the Access HTML login page instead of the API, and pairing fails. The bypass does not open the Worker — every `/api/local/*` route still requires a valid adapter bearer token; it only removes the IdP challenge.

## Pair a machine

1. In the dashboard, open **Remote Access** and click **Add computer**.
2. Copy the connect command. It looks like this:

   ```sh
   node scripts/shiba-local-daemon.mjs --connect https://shiba.example.com --pair <token>
   ```

3. Run it from a checkout of this repository on the machine you want to pair.

The pairing token works once and expires after 15 minutes; the modal shows a countdown. The daemon sends the token to `POST /api/local/pair`. The Worker checks the token's HMAC signature and expiry, then burns its nonce, so the same token can't be used twice. On success the Worker returns a new adapter token and a machine id, and the daemon starts polling.

If the token was expired, already used, or mistyped, the daemon exits with a message telling you to mint a new one. Mint a new token and run the command again.

## Files on the machine

The daemon keeps its state in `~/.shiba-local/`. Set `SHIBA_LOCAL_RUN_ROOT` to use a different directory.

| File | Contents | Mode |
| --- | --- | --- |
| `config.json` | `{workerUrl, adapterToken, machineId}`, written by `--connect`/`--pair` | `0600` |
| `machine-id` | A random UUID, created once and reused across restarts | `0600` |

The directory is created with mode `0700`. Pairing again overwrites `config.json` and tightens its permissions to `0600`.

The older environment-variable setup still works. If `SHIBA_WORKER_URL` and `LOCAL_ADAPTER_TOKEN` are set, they take precedence over `config.json`. In that mode the daemon authenticates with the deployment-wide bearer, not a per-machine token.

## Heartbeat and status

At startup the daemon checks which harnesses are installed by running `claude`, `codex`, `opencode`, and `agy` with `--version`. Each check has a 5-second timeout. Only the names of harnesses that respond are reported; version strings are not.

The daemon then sends a heartbeat to `POST /api/local/heartbeat` every 30 seconds. Each heartbeat includes the machine id, hostname, platform (`process.platform-process.arch`, such as `darwin-arm64`), daemon version, harness list, and the id of the run in progress, if any.

The dashboard polls `/api/computers` every 10 seconds and shows one of three statuses:

| Status | Meaning |
| --- | --- |
| `busy` | The last heartbeat reported an active run. |
| `idle` | The last heartbeat arrived within 75 seconds and reported no active run. |
| `offline` | No heartbeat for more than 75 seconds. |

Expect some lag. A machine can show `idle` or `busy` for up to about 30 seconds after the real change, plus up to 10 seconds of dashboard polling. A machine that stops reporting shows `offline` only after 75 seconds, which is two missed heartbeats plus slack.

A failed heartbeat caused by a network error is logged, and the daemon tries again on the next tick. Records for machines that have not sent a heartbeat in 7 days are deleted. A deleted machine has to be paired again.

## Revoke a machine

Click **Revoke** on a machine and confirm. This calls `POST /api/computers/revoke`, which deletes the machine record, including the stored hash of its adapter token. The machine's next heartbeat or claim then gets a `401`. The daemon logs `adapter token revoked; re-pair` and exits with code `78`, so a process supervisor can treat it as a configuration error instead of restarting it in a loop.

Things revocation does not do:

- The Worker can't cancel a run that is already in progress on the machine. The daemon only exits after its next heartbeat or claim gets a `401`, which can take up to about 30 seconds.
- It can't revoke a daemon running in environment-variable mode. That daemon uses the deployment-wide `LOCAL_ADAPTER_TOKEN`, so you have to rotate that secret to cut it off.
- It does not delete `~/.shiba-local/` on the machine. Remove the directory yourself if you are retiring the machine.

## Desktop app

Shiba Desktop (macOS only) wraps the same dashboard in an app and adds one-click pairing. It only makes outbound calls and adds no approval path: local runs still need the approval card in the dashboard.

### Install

Shiba Desktop is a local macOS prototype. If your operator provides a build, follow their installation instructions. Public signed distribution is not established by these setup notes.

If you build locally with `pnpm --filter @shiba/desktop dist`, the unsigned app is killed at launch on Apple silicon (`Code Signature Invalid`) because the fused binary keeps an invalid signature — re-sign it ad-hoc once:

```sh
pnpm --filter @shiba/desktop dist:local   # builds, then ad-hoc signs the .app
```

### First run

The app asks for your Shiba URL, then loads the dashboard. Sign in as usual. Only that origin and your sign-in providers load inside the app; other links open in your browser. **Change Shiba URL…** in the tray menu reopens the prompt.

### Connect this computer

Open **Remote Access** and click **Connect this computer**. The app pairs this machine to the Shiba URL you configured and starts the daemon, so you don't copy a command or token. The machine then appears in the fleet list as **This computer**. **Disconnect this computer** in the tray menu unpairs it.

### Tray states

| State | Tray label | What it means |
| --- | --- | --- |
| Signed out | Sign in to Shiba | You aren't signed in to the dashboard. |
| Disabled | Local runs disabled on this Shiba | The Worker has the local runtime off. |
| Not connected | Not connected | This computer isn't paired. |
| Paired elsewhere | Paired to another Shiba | This computer is paired to a different URL. Reconnecting asks you to confirm. |
| Connected, idle | Connected · idle | The daemon is polling. |
| Busy | Running · owner/repo | A local run is in progress. |
| Offline | Offline · retrying | Heartbeats are failing. The daemon retries by itself. |
| Revoked | Revoked · reconnect | The machine was revoked. The app doesn't restart the daemon; connect again. |
| Conflict | Another daemon is running | A CLI or other daemon holds this machine's lock. The app doesn't restart it. |
| Crashed | Daemon crashed · View logs | Five abnormal exits within 10 minutes. The app stops restarting it. |

Other abnormal exits restart the daemon after 1s, 2s, 4s and so on, up to 60s. The harness list can show `agy`. It is listed but can't run local tasks.

### Logs

The app writes `<userData>/logs/main.log` and `daemon.log`. On macOS `<userData>` is `~/Library/Application Support/Shiba`. Each file rotates at 5 MB and keeps one `.1` copy. **View logs** in the tray menu opens the folder.

### Notifications

The app notifies you when an approval is waiting and when a run finishes. Clicking either opens the dashboard. Notifications show only the title and `owner/repo`, and you can never approve or reject from one. Toggle them with **Notifications** in the tray menu.

### Start at login and quitting

**Start at login** in the tray menu launches the app hidden at login. Closing the window hides the app to the tray. Quit from the tray menu or with Cmd+Q. If a local run is in progress, the app asks first. Quitting stops the run and reports it failed.

### Uninstall

Quit the app, delete Shiba from Applications, and remove `~/.shiba-local` to drop the pairing and machine id. Revoke the machine from the dashboard if you want its token invalidated on the Worker.

## Security model

- **The approval gate does not change.** Every local run still requires the approval card and the same approval checks as any other run. Pairing a machine only gives the daemon a way to receive work you have already approved.
- **Provider credentials never pass through the Worker.** The machine's harnesses use the credentials already on the machine. The only credential the Worker issues is the adapter token, which is a Shiba bearer token, not a provider key.
- **The Worker never stores adapter tokens in plain text.** It keeps only a SHA-256 hash, and the dashboard never shows the token. The plain token exists only in the pairing response and in the machine's `config.json`.
- **Pairing tokens are short-lived and single-use.** Each token is signed with HMAC-SHA256, expires after 15 minutes, and its nonce is deleted the first time it is used.
- **Only the dashboard can start local work.** Local runs are created from the dashboard only. The `/api/computers*` routes require dashboard sign-in, the daemon bearer only reaches `/api/local/*`, and no chat surface can reach either set of routes.

## Limits

- This is built for a single tenant. If `PAIRING_SECRET` is unset, pairing tokens are signed with the deployment's `LOCAL_ADAPTER_TOKEN`.
- Checking a daemon's token reads through the whole fleet on every daemon call. That is fine for a handful of machines and has not been measured for large fleets.
- Status lags reality by up to about 40 seconds for a change and 75 seconds for going offline. Use the run timeline, not the fleet view, to see what a task is doing.
- The connect command assumes the machine has a checkout of this repository and Node.js 22.12.0+ installed.

Return to [Remote access](/docs/remote-access/).

### Troubleshooting (desktop + daemon)

| Symptom | What to check |
| --- | --- |
| Tray stays on **Sign in to Shiba** after you signed in | The app URL must match `BETTER_AUTH_URL` (better-auth) or your Access session must cover the configured origin. Close and reopen the window, or use **Change Shiba URL…** if you pointed at the wrong deployment. |
| **Local runs disabled on this Shiba** | Set `SHIBA_LOCAL_RUNTIME=1` and bind `LocalDispatch` on the Worker, then reload Remote Access. |
| **Connect this computer** fails immediately | Mint a fresh pairing token (15-minute TTL, single use). Ensure `PAIRING_SECRET` or `LOCAL_ADAPTER_TOKEN` is set so pairing-token does not return 503. |
| Pairing command or daemon logs show HTML | Add an Access **Bypass** (or equivalent) for `<your-host>/api/local/*` so the daemon reaches the Worker API, not the IdP login page. |
| Fleet list empty but tray says connected | Wait for the next heartbeat (up to ~30s) and fleet poll (10s). Revoke stale rows if you reinstalled without revoking. |
| Local run queued but never starts | Pair only one machine for testing; choose **Local (Paired computer)** and the correct hostname in the composer so `targetMachineId` matches. Approve on the dashboard card — notifications only open Approvals. |
| **Another daemon is running** | Stop a CLI `shiba-local-daemon.mjs` or another Shiba Desktop instance; only one process may hold `daemon.lock`. |

For the full manual acceptance checklist (signing, fuses, notifications), see `VERIFICATION/desktop.md` at the repository root.
