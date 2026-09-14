# Stateless V3 video projects

V3 orchestrates long videos without a database, persistent queue, background worker, or permanent object storage. V1/V2 routes remain unchanged. The Custom GPT creates the visual bible and scene prompts; the middleware enforces technical rules and never calls another LLM.

## Workflow

1. `POST /video/projects/start` validates the complete plan and returns a signed Project State Token. It never calls SnapGen.
2. `POST /video/projects/continue` verifies the latest token and performs one step: one `POST /video/generate` for the next pending scene, or one status lookup for the UUID of the processing scene.
3. After every successful call, the client must discard the previous token and retain only the replacement.
4. When every scene is complete, `POST /video/projects/render` refreshes each media URL from its UUID, downloads the clips, normalizes them, concatenates them, and trims the final MP4.
5. The returned download URL points to an ephemeral local file and expires after a short configured interval.

Only `veo-3.1-fast` is enabled initially. It uses independent eight-second generations. Although the V2 capability says that Extend exists, the real chaining test did not complete successfully, so `extendChainValidated` is `false` and V3 never invokes Extend automatically.

## Project State Token

The format is:

```text
pst1.<base64url(deflateRaw(JSON))>.<base64url(HMAC-SHA256)>
```

The signature covers the prefix and compressed payload and is compared in constant time. The payload contains project parameters, the visual bible, scenes, UUIDs, states, budget counters, timestamps, schema version, and monotonic token version. It contains no API keys, provider credentials, or provider media URLs.

`PROJECT_STATE_SECRET` signs new tokens and must be an independent high-entropy secret of at least 32 characters. `PROJECT_STATE_SECRET_PREVIOUS` is optional and allows one rotation window; new tokens always use the current secret.

The default token limit is 65,536 bytes. `start` reserves 8,192 bytes inside that envelope for UUIDs, errors, counters, and final-output metadata that can be added later. Ordinary 9- and 23-scene payloads are compressed below that limit. Unusually long and varied prompts can exceed it; `start` then returns `PROJECT_STATE_TOO_LARGE` before any paid call. The uncompressed schema also enforces per-field limits.

## Budget and paid calls

`maxPaidOperations` equals the deterministic scene count. `maxAttemptsPerScene` is 1 and `automaticPaidRetries` is 0. An accepted or ambiguous submission consumes one budget unit. A scene with a UUID is polled and is never generated again when the current token is used.

Each `continue` call performs at most one potentially paid POST. Polling and rendering do not make paid POSTs.

## Stateless replay limitation

A valid old token cannot be revoked without server-side state. If T1 says scene 2 is pending, a successful call may return T2 containing its UUID. Replaying T1 can submit scene 2 again because a stateless server cannot know that T2 exists.

Token versions, nonces, chained hashes, or request binding make tampering detectable but cannot tell a stateless server that a newer token has already been issued. They do not eliminate replay.

The supplied SnapGen documentation does not define a generation idempotency key and does not define lookup by `request_id` or `x-request-id`. The middleware request ID is useful for tracing only. If SnapGen may have accepted a POST but no UUID arrives—including timeout, network failure, or a provider 5xx—the scene becomes `ambiguous`, the project becomes `failed`, and `retryable` is false.

Initial safeguards:

- always replace the previous token with the newest response;
- never call `continue` concurrently;
- never reuse a token from an earlier message/tool result;
- process only one project at a time per conversation;
- never retry a failed or ambiguous scene automatically.

Complete replay prevention requires provider-native idempotency/lookup or server-side persistence. V3 does not claim otherwise.

## History and media lifetime

The supplied documentation states that `GET /uapi/v1/history/{conversion_uuid}` returns nested `generated_video[].video_url`. It also exposes `expired_at`. It does not promise that a URL is permanent, that every GET returns a new URL, or that the same URL remains valid until a fixed date.

V3 stores only SnapGen UUIDs and asks the history endpoint for a current URL immediately before rendering. Rendering can fail if history or media has expired. A future optional storage adapter can persist completed segments without changing the workflow, but no storage integration is included now.

## Secure download and rendering

Media download requires HTTPS, disallows embedded credentials and local/private/reserved destinations, revalidates redirects, optionally enforces `SNAPGEN_MEDIA_ALLOWED_HOSTS`, limits redirects, bytes, and time, validates content type, and removes partial files. Query strings from provider URLs are never logged.

`ffprobe` verifies a video stream. Each clip is normalized to H.264, `yuv420p`, 30 FPS, requested dimensions, and AAC 48 kHz stereo. A silent audio stream is added when needed. FFmpeg concatenates normalized clips and trims/re-encodes to the requested duration with MP4 `faststart`.

## Ephemeral output

The final file lives in the container temporary filesystem. The response includes a short-lived signed download URL. This is not durable storage:

- restart or deploy can remove the output immediately;
- a different instance may not have the file;
- expiry or cleanup makes it unavailable;
- the client should download immediately.

Reliable retention is impossible on ephemeral Render storage without external storage, deliberately outside this version.
