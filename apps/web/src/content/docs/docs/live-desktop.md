---
title: Live desktop
description: Optional in-sandbox graphical desktop for task workspace streaming and computer-use tools.
---

Shiba can start a **headless desktop** inside the sandbox container when you opt in. The dashboard task page exposes it in the **Desktop** workspace tab (noVNC stream, view-only by default).

## Enable

Set on the Worker (and rebuild the sandbox image):

```bash
SHIBA_SANDBOX_DESKTOP=1
DESKTOP_STREAM_SECRET=<random>   # optional; falls back to PAIRING_SECRET
WORKER_HOSTNAME=app.example.com  # required to mint preview/desktop URLs
```

When the flag is **unset**, runs stay on the lean image path: computer-use tools (`screen_*`) still exist, but there is no live stream until the desktop stack is enabled and started for a run.

## Resources and cost

The desktop layer adds **Xvfb, a window manager, Chromium, x11vnc, and noVNC** to the container image and consumes extra CPU/RAM while a run is active. Streams are started **on demand** (first Desktop tab open or agent-driven session), not for every sandbox.

Budget for longer container lifetime and a larger instance type if agents keep the desktop open.

## Security model

- **No public VNC port.** The container exposes websockify only through Cloudflare Sandbox **`exposePort`**, which mints a **tokenized** hostname. The dashboard never receives that raw URL.
- **Short-lived signed URLs** gate the same-origin embed and WebSocket proxy (`DESKTOP_STREAM_SECRET` / pairing secret).
- **VNC password** is generated per session and passed only to the authenticated embed page over HTTPS.
- **Take control** sets `desktopInputMode: human`, which **pauses agent screen input** (`POST /api/runs/<id>/screen` returns 409) until **Hand back**.
- Workspace routes require the same **dashboard auth** as `/api/runs` (Cloudflare Access or better-auth). Agent tokens only see runs they queued.

## Computer-use tools

Harness and MCP tools: `screen_click`, `screen_type`, `screen_scroll`, `screen_key`, `screen_shot`, `screen_open_url`. Screenshots can be stored as run artifacts when captured during a run.

See [Architecture](/docs/architecture/) for the approval-gated pipeline and [Self-hosting](/docs/self-hosting/) for deploy variables.
