---
title: Images, videos, reports, pages, and Outputs
description: What Chat can create, media models and shapes, generated documents, and authenticated output routes.
---

Outputs brings together images, videos, reports, web pages, and downloadable run archives. Generated media belongs to its signed-in creator, with personal file access and generation details saved alongside the file. Download URLs are authenticated Worker routes, not public storage URLs.

## Choosing what Chat creates

Chat never generates on its own. In the Chat composer, open **Create** and pick **Image**, **Video**, **Report**, or **Page** for the message you are about to send. That choice switches on exactly one generation tool for that one message; the next message starts with nothing chosen. **Web** and **Knowledge** lookups stay separate, so a report can use search results when you switch Web on too. With nothing chosen, Chat answers in text only.

Examples:

- **Report** with **Web** on: "Write a two-page brief on heat pump adoption in Europe since 2022, with sources."
- **Page**: "A one-page launch announcement for our spring workshop, with a schedule table and a sign-up note."

## Reports and pages

A report is Markdown the assistant writes and saves with the sources it actually used, listed at the end and cited as [1], [2]. Chat shows the title and source count; **Read report** opens the full text and **Download** saves the `.md` file.

A page is one self-contained static HTML document. The saver refuses scripts, event handlers, forms, frames, external stylesheets, fonts, and remote images (`data:` images are allowed), and adds a restrictive content policy to the saved file. Chat and Outputs show the page in a sandboxed preview that cannot run scripts or reach the dashboard; **Download** saves the `.html` file.

Both are private files of the signed-in user, up to 128 KB each, and appear in Outputs under **Documents**. Writing them makes no extra model or provider call beyond the chat reply itself, and needs no approval. Unlike run deliverables, they do not expire with run archives.

## Images

The image tool and **Create an image** use Workers AI, not an external image vendor credential. Available styles are Flux Schnell (square only), Lucid Origin, Phoenix, and SDXL Lightning. Cloudflare currently lists SDXL Lightning for planned retirement on November 20, 2026; remove it from the catalog when retired. Availability still depends on the deployment's Workers AI account.

| Shape | Dimensions sent to dimension-capable models |
| --- | --- |
| 1:1 | 1024 × 1024 |
| 16:9 | 1024 × 576 |
| 9:16 | 576 × 1024 |
| 4:3 | 1024 × 768 |
| 3:4 | 768 × 1024 |

Without an explicit model, squares use Flux Schnell and other shapes use Lucid Origin. Flux Schnell receives no dimension parameters; an explicit non-square request with it fails rather than silently making a square. Legacy `aspect` values `square`, `landscape`, and `portrait` map to 1:1, 16:9, and 9:16; `aspectRatio` takes precedence.

The catalog and provider contracts live in `apps/backend/src/tools/image-models.ts`. Cloudflare's model input/output schemas were checked for [Flux Schnell](https://developers.cloudflare.com/workers-ai/models/flux-1-schnell/), [Lucid Origin](https://developers.cloudflare.com/workers-ai/models/lucid-origin/), [Phoenix](https://developers.cloudflare.com/workers-ai/models/phoenix-1.0/), and [SDXL Lightning](https://developers.cloudflare.com/workers-ai/models/stable-diffusion-xl-lightning/). Flux and Lucid return base64 images; Phoenix returns JPEG and Lightning returns PNG binary streams. The adapter also accepts binary arrays.

## Videos

Video generation retains the existing Google connection and deployment enablement settings. A personal Google key must be connected. Dashboard chat and Slack ask for human confirmation before starting a paid job. MCP reports `approval_required` and cannot approve spending. Provider failures and timeouts may still be billed; check the provider account before retrying.

All modes accept a prompt, 3–8 seconds, and 16:9, 9:16, or 1:1. Only the sources listed for a mode are permitted:

| Mode | Sources | Purpose |
| --- | --- | --- |
| `text-to-video` | None | Create from a description |
| `image-to-video` | `sourceImageArtifactId` | Animate an image |
| `reference-to-video` | `referenceImageArtifactIds` (1–3) | Keep a character or subject |
| `motion-control` | `sourceImageArtifactId`, `referenceVideoArtifactId` | Copy motion onto an image |
| `video-editing` | `sourceVideoArtifactId` | Edit a video using the prompt |

Omitting mode defaults to text-to-video, except legacy requests containing a source image retain image-to-video behavior. Sources must be unarchived artifacts owned by the requester in the same workspace. Images must be PNG/JPEG up to 10 MB; videos must be MP4 up to 50 MB. The backend advertises supported modes and sends sources as image/video content parts with the prompt in the existing background interactions request. Provider acceptance and quality depend on the connected account; these are not guarantees of live provider availability.

## Generate media in Slack

Mention Shiba with `generate image <description>` or send it as a direct message. A completed image is attached in the same thread. If you have linked your Slack user to your Shiba workspace, the image is also in **Outputs**.

Use `generate video <description>` for an eight-second text-to-video clip. Video requires a managed Slack installation with `files:write`, a linked Slack identity, and your own Google API key. Select **Generate video** on the confirmation card in the same thread. Only the requester can confirm, within ten minutes, and they must be on the Slack approver list.

Slack attachments are visible to the conversation's audience. See [Slack delivery requirements](/docs/slack/#get-files-back-in-the-thread) before generating from sensitive material.

## HTTP API

These routes use the same signed-in identity and workspace resolution as Outputs:

- `GET /api/outputs?type=image|video|document|archive|output`: list accessible items, newest first. Omit type for all items. `output` includes media and generated documents; `document` lists only reports and pages generated in Chat (ordinary uploaded Markdown or HTML is not included) and each carries `documentKind` `report` or `page`. Optional `media` contains kind, mode, model, label, prompt, aspectRatio, width, height, durationSeconds, and sourceIds. Older uploaded files may not have generation metadata.
- `GET /api/outputs/media-options`: image model labels and dimension support, image aspect ratios, and per-user video enablement with available modes/shapes. Disabled options are omitted from the lists.
- `POST /api/outputs/images`: JSON `{ "prompt": "A coastal town", "model": "@cf/leonardo/lucid-origin", "aspectRatio": "16:9" }`. Model and shape are optional. Success (201) includes artifactId and downloadPath.
- `GET /api/files/:id/download`: authenticated inline media, suitable for an image or video preview, with private/no-store caching. HTML, SVG, XML, and Markdown files always download as attachments under a sandboxing content policy.
- `GET /api/files/:id/preview`: a Chat-generated page only, served inline under `Content-Security-Policy: sandbox` with scripts, network access, forms, and framing by other sites blocked.

Migration `0062_media_generations.sql` adds file-linked generation provenance. Failed registration removes metadata and the file row before removing private bytes. If the database is unavailable during cleanup, bytes remain private rather than deleting a possibly referenced object.

MCP token principals are not necessarily user identities (API key principals are arbitrary labels). Until a trustworthy owner mapping exists, image generation through MCP retains private legacy storage and returns a storage key, without adding an ownerless file to the gallery. Chat and HTTP image generation provide explicit user/workspace context.
