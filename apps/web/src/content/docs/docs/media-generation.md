---
title: Images, videos, and Outputs
description: Media generation models, shapes, source artifacts, and authenticated output routes.
---

Outputs brings together images, videos, and downloadable run archives. Generated media belongs to its signed-in creator, with personal file access and generation details saved alongside the file. Download URLs are authenticated Worker routes, not public storage URLs.

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

Video generation retains the existing Google connection and deployment enablement settings. A personal Google key must be connected. Dashboard chat asks for human confirmation before starting a paid job. MCP reports `approval_required` and cannot approve spending. Provider failures and timeouts may still be billed; check the provider account before retrying.

All modes accept a prompt, 3–8 seconds, and 16:9, 9:16, or 1:1. Only the sources listed for a mode are permitted:

| Mode | Sources | Purpose |
| --- | --- | --- |
| `text-to-video` | None | Create from a description |
| `image-to-video` | `sourceImageArtifactId` | Animate an image |
| `reference-to-video` | `referenceImageArtifactIds` (1–3) | Keep a character or subject |
| `motion-control` | `sourceImageArtifactId`, `referenceVideoArtifactId` | Copy motion onto an image |
| `video-editing` | `sourceVideoArtifactId` | Edit a video using the prompt |

Omitting mode defaults to text-to-video, except legacy requests containing a source image retain image-to-video behavior. Sources must be unarchived artifacts owned by the requester in the same workspace. Images must be PNG/JPEG up to 10 MB; videos must be MP4 up to 50 MB. The backend advertises supported modes and sends sources as image/video content parts with the prompt in the existing background interactions request. Provider acceptance and quality depend on the connected account; these are not guarantees of live provider availability.

## HTTP API

These routes use the same signed-in identity and workspace resolution as Outputs:

- `GET /api/outputs?type=image|video|archive|output`: list accessible items, newest first. Omit type for all items. `output` includes both media types. Optional `media` contains kind, mode, model, label, prompt, aspectRatio, width, height, durationSeconds, and sourceIds. Older uploaded files may not have generation metadata.
- `GET /api/outputs/media-options`: image model labels and dimension support, image aspect ratios, and per-user video enablement with available modes/shapes. Disabled options are omitted from the lists.
- `POST /api/outputs/images`: JSON `{ "prompt": "A coastal town", "model": "@cf/leonardo/lucid-origin", "aspectRatio": "16:9" }`. Model and shape are optional. Success (201) includes artifactId and downloadPath.
- `GET /api/files/:id/download`: authenticated inline media, suitable for an image or video preview, with private/no-store caching. Browser download links can request saving the file.

Migration `0061_media_generations.sql` adds file-linked generation provenance. Failed registration removes metadata and the file row before removing private bytes. If the database is unavailable during cleanup, bytes remain private rather than deleting a possibly referenced object.

MCP token principals are not necessarily user identities (API key principals are arbitrary labels). Until a trustworthy owner mapping exists, image generation through MCP retains private legacy storage and returns a storage key, without adding an ownerless file to the gallery. Chat and HTTP image generation provide explicit user/workspace context.
