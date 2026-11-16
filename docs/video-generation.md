# Video generation

Video generation is off by default. It uses the signed-in chat owner's personal
Google API key from **Settings → Providers → Gemini**. The key stays in the
Worker; it is never passed to a sandbox or returned in tool results.

Set these Worker environment variables on a development or preview installation:

```text
SHIBA_VIDEO_GENERATION=1
SHIBA_VIDEO_BACKEND=google
```

Existing `ARTIFACTS`, `AGENT_AUDIT`, `AGENT_TOKENS`, and
`MODEL_CREDENTIAL_KEY` bindings must be configured. No new provider secret is
needed. Turning on the flag alone does not configure a backend. Deployment
configuration is not changed by this feature.

The backend is Google's `gemini-omni-1.2-flash` via the Interactions API.
Google retired the Veo preview API in October 2026. See the
[Google video notice](https://aistudio.google.com/docs/video),
[video request format](https://aistudio.google.com/docs/omni), and
[background job contract](https://aistudio.google.com/docs/background-execution).
The adapter pins API revision `2026-05-20`.

In dashboard chat, ask for a video. The `generate_video` tool accepts:

- `prompt`: 1–2000 characters.
- `duration`: a whole number of seconds, 3–8 (default 8).
- `aspectRatio`: `16:9` (default) or `9:16`.
- `sourceImageArtifactId`: optional file artifact ID for an owned PNG or JPEG,
  at most 10 MB, in the same workspace.

Each generation requires the existing human tool confirmation before a provider
job starts. Text-to-video and image-to-video are supported. A start request is
never retried automatically because its outcome may be billable. The Worker
polls at ten-second intervals for up to 60 polls. On timeout, check the provider
account before retrying: the provider may still finish and charge for the job.
There is no restart recovery for an interrupted polling request in this slice.

Completed MP4s (up to 50 MB) are stored privately in `ARTIFACTS`, with a personal
file record and an authenticated `/api/files/:id/download` path. Chat tool
results, task MP4 deliverables, and Outputs show native video controls.
Provider URLs and credentials are never used as browser video sources.

`GET /api/capabilities` and `GET /api/v1/capabilities` include
`video: { enabled, reason }`. A missing flag, backend, storage, or personal key
returns a disabled reason. API-key callers cannot borrow a user's personal key.
The tool is omitted when the deployment flag/backend/storage is unavailable.
Without a connected key, execution returns a plain connection message.

MCP registers the same tool name only for configured deployments, but directs
requests to dashboard chat for human confirmation. An agent-supplied approval
boolean never authorizes spending.

Follow-ups: room-scoped artifact sharing, paid MCP execution after a durable human
approval, reference-to-video, video editing, motion control, caption tracks, and
job recovery after request interruption. Personal files remain private until a
room sharing contract is implemented.

Validation: mocked jobs cover start, polling, completion, provider failure,
timeout, duration bounds, image ownership, MP4 storage, and approval gating.
Frontend tests cover the native player. A local built bundle includes the player.
A deployed preview check requires a preview URL and authenticated access; this
change does not deploy. Live generation **needs a provider key for a live
generation**.
