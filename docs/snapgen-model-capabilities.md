# SnapGen video model capabilities

Source: the supplied SnapGen `docs-content.zip` Markdown and OpenAPI files. This is an implementation reference, not a substitute for checking newer upstream documentation.

## Generation families

| Family / models | Endpoint | Duration | Resolution | Aspect ratios | Image references | Extend |
|---|---|---|---|---|---|---|
| `veo-3.1`, `veo-3.1-fast`, `veo-3.1-lite` | `POST /uapi/v1/video-gen/veo` | fixed 8s | 720p, 1080p | 16:9 | `ref_images`, repeated; frame max 2, ingredient max 3 | `POST /uapi/v1/video-extend/veo` |
| `veo-2` | same Veo endpoint | fixed 8s | 720p | 16:9, 9:16 | same as Veo | same Veo extend endpoint |
| `omni-flash` | same Veo endpoint | 4, 6, 8, 10s | 720p, 1080p | 16:9, 9:16 | images; documentation also lists reference video support | not enabled in V2 registry |
| `grok-3` | `POST /uapi/v1/video-gen/grok` | 6, 10, 15s | 480p, 720p | landscape, portrait, square, vertical, horizontal | URL inputs use repeated `file_urls`; max 5 documented by the equivalent lower route | `POST /uapi/v1/video-extend/grok` |
| `grok-lower` | `POST /uapi/v1/video-gen/grok-lower` | 6, 10, 15s | 480p, 720p, 1080p | landscape, portrait, square, 3:2, 2:3 | repeated `file_urls`, max 5; upstream `ref_images` means prior image UUIDs | not enabled for extend |
| `seedance-2` | `POST /uapi/v1/video-gen/seedance` | 4–15s | 720p confirmed by OpenAPI default | 16:9, 9:16, 1:1, 3:4, 4:3, 21:9 | repeated `ref_images`, max 2, first/last frame | `POST /uapi/v1/video-extend/seedance` |
| `seedance-2-omni` | same Seedance endpoint | 4–15s | 720p confirmed by OpenAPI default | same Seedance ratios | repeated `ref_images`, max 4 ingredients | same Seedance extend endpoint |
| `seedance-2-mini` | same Seedance endpoint | 4–15s | 720p confirmed by OpenAPI default | same Seedance ratios | repeated `ref_images`, max 2, first/last frame | same Seedance extend endpoint |
| `seedance-2-5-omni` | same Seedance endpoint | 4–30s | 720p confirmed by OpenAPI default | same Seedance ratios | repeated `ref_images`, max 14 ingredients | same Seedance extend endpoint |
| `flux-3` | `POST /uapi/v1/video-gen/flux` | 5–20s | not exposed as a documented request option | 16:9, 9:16, 1:1, 3:4, 4:3, 2:1, 21:9 | repeated `ref_images`, max 10 | no documented extend endpoint |
| `minimax-h3` | `POST /uapi/v1/video-gen/minimax` | 5–15s | not exposed as a documented request option | 16:9, 9:16, 1:1, 3:4, 4:3, 21:9 | repeated `ref_images`, max 9 | no documented extend endpoint |
| Kling text/image models | `POST /uapi/v1/video-gen/kling` | 3–15s for current models; legacy IDs fixed at 5s or 10s | mode determines 720p/1080p | 16:9, 9:16, 1:1 | repeated `ref_images`, max 4 | upstream endpoint exists, but V2 does not expose it because the supplied guide does not define enough model-specific behavior |

Kling IDs enabled: `kling-video-3-0`, `kling-video-2-6`, `kling-video-o1`, `kling-video-2-5`, `kling-video-2-1-10s`, `kling-video-2-1-5s`, `kling-video-1-6-10s`, and `kling-video-1-6-5s`.

Kling motion/edit models are not enabled because they require reference video uploads and duration extraction from the uploaded media. The public V2 currently accepts reference image URLs only.

## Modes and defaults

- Veo: duration 8, resolution 720p, aspect ratio 16:9. `mode_image` is `frame` or `ingredient`.
- Grok: duration 6, resolution 480p, landscape, mode `custom`; optional `skip_audio`.
- Seedance defaults from OpenAPI: duration 4, resolution 720p, aspect ratio 16:9, mode `fast` except `business_mini` for Mini and `cheap` for 2.5 Omni.
- Flux: mode `vip`; V2 default duration 10 and aspect ratio 16:9 based on the supplied example.
- MiniMax: mode `standard`; V2 default duration 8 and aspect ratio 16:9 based on the supplied example.
- Kling: duration 5 where not fixed, 16:9, mode `standard`. `standard` and `relax` produce 720p; `professional` and `professional_audio` produce 1080p.

## Extend

The three implemented extend endpoints accept exactly `prompt` and `ref_history` upstream. Model, resolution, duration and aspect ratio are inherited from the source generation. The public middleware accepts `model`, `source_uuid`, and `prompt`; `model` selects the documented family endpoint and `source_uuid` becomes `ref_history`.

## Storyboard

`POST /uapi/v1/video-storyboard/grok` accepts a JSON-encoded `scenes` multipart field, 2–10 scenes, scene durations of 6 or 10 seconds, and a maximum combined duration of 45 seconds. Ratios are landscape, portrait, or square; resolutions are 480p or 720p; models are `grok-video` or alias `grok-3`.

## History and webhooks

Status is polled at `GET /uapi/v1/history/{conversion_uuid}`. Common codes are 1 processing, 2 completed, and 3 failed. Kling also documents 0 pending; Grok Lower documents -2 for policy rejection. V2 maps 0/1 to processing, 2 to completed, and 3/-2 to failed.

SnapGen webhooks support completion/failure events and an `x-signature` verification scheme. V2 retains polling: webhook state would need idempotency and a configured public key, and offers no benefit to the stateless GPT flow yet.

## Upload decision

No upload endpoint is implemented. Render's ephemeral filesystem is not a reliable public media store, and choosing a third-party persistent service would add an unrequested account/cost dependency. V2 accepts public HTTP(S) reference URLs and keeps storage behind a future abstraction. A future upload service must enforce MIME allowlists, size limits, randomized names, expiry, cleanup, and non-executable delivery.
