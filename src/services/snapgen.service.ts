import { SnapGenError } from '../errors.js';
import type { AppEnv } from '../config/env.js';
import type { StoryboardInput, VideoExtendInput, VideoGenerateInput } from '../schemas/video.schema.js';
import type { VideoGeneration, VideoGenerationStatus, VideoOperation, VideoProvider } from '../providers/video.provider.js';
import { createLogger, type Logger } from '../utils/logger.js';
import { videoModelRegistry } from '../models/video-model.registry.js';
import { ApiError } from '../errors.js';

type FetchImplementation = typeof fetch;

function redact(value: unknown, secrets: string[]): unknown {
  if (typeof value === 'string') {
    return secrets.reduce((text, secret) => (secret ? text.replaceAll(secret, '[REDACTED]') : text), value);
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, /api[-_]?key|authorization/i.test(key) ? '[REDACTED]' : redact(item, secrets)]),
    );
  }
  return value;
}

async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : {};
}

function responseUuid(value: UnknownRecord): string | undefined {
  if (typeof value.uuid === 'string' && value.uuid) return value.uuid;
  if (typeof value.conversion_uuid === 'string' && value.conversion_uuid) return value.conversion_uuid;
  return undefined;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new SnapGenError(502, { message: `Invalid SnapGen response: missing ${field}` });
  return value;
}

function snapGenStatus(value: unknown): VideoGenerationStatus['status'] {
  if (value === 0 || value === 1) return 'processing';
  if (value === 2) return 'completed';
  if (value === 3 || value === -2) return 'failed';
  throw new SnapGenError(502, { message: 'Invalid SnapGen response: unknown status' });
}

function normalizedProgress(status: VideoGenerationStatus['status'], value: unknown): number {
  if (status !== 'processing') return 100;
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

export class SnapGenService implements VideoProvider {
  private readonly logger: Logger;

  constructor(
    private readonly env: AppEnv,
    private readonly fetchImplementation: FetchImplementation = fetch,
    logger?: Logger,
  ) {
    this.logger = logger ?? createLogger(env.LOG_LEVEL);
  }

  async generateVideo(input: VideoGenerateInput, requestId: string): Promise<VideoGeneration> {
    const resolved = videoModelRegistry.resolve(input);
    const model = resolved.model;
    const videoInput = resolved.input;
    const form = new FormData();
    form.append('prompt', videoInput.prompt);
    if (model.includeModel) form.append('model', videoInput.model);
    form.append('duration', String(videoInput.duration));
    if (model.includeResolution && videoInput.resolution) form.append('resolution', videoInput.resolution);
    form.append('aspect_ratio', videoInput.aspect_ratio);
    if (videoInput.mode) form.append('mode', videoInput.mode);
    if (videoInput.mode_image) form.append('mode_image', videoInput.mode_image);
    if (videoInput.skip_audio !== undefined) form.append('skip_audio', String(videoInput.skip_audio));
    for (const imageUrl of videoInput.ref_images) form.append(model.referenceField, imageUrl);

    const raw = asRecord(await this.request(model.endpoint, { method: 'POST', body: form }, requestId, 'generateVideo', {
      model: model.id, provider: 'snapgen', inputMode: videoInput.ref_images.length ? 'image-to-video' : 'text-to-video',
    }));
    const uuid = requiredString(responseUuid(raw), 'uuid or conversion_uuid');
    return { uuid, status: 'processing', provider: 'snapgen', model: videoInput.model };
  }

  async getVideo(uuid: string, requestId: string): Promise<VideoGenerationStatus> {
    const raw = asRecord(await this.getWithRetry(`/uapi/v1/history/${encodeURIComponent(uuid)}`, requestId));
    const responseUuid = requiredString(raw.uuid, 'uuid');
    const status = snapGenStatus(raw.status);
    const generatedVideo = Array.isArray(raw.generated_video) ? asRecord(raw.generated_video[0]) : {};
    const videoUrl = status === 'completed' && typeof generatedVideo.video_url === 'string' ? generatedVideo.video_url : null;
    const result: VideoGenerationStatus = {
      uuid: responseUuid,
      status,
      progress: normalizedProgress(status, raw.status_percentage),
      videoUrl,
      provider: 'snapgen',
    };
    if (status === 'failed') {
      const message = raw.error_message ?? generatedVideo.error_message;
      result.error = typeof message === 'string' && message ? message : 'Video generation failed';
    }
    return result;
  }

  async extendVideo(input: VideoExtendInput, requestId: string): Promise<VideoOperation> {
    const model = videoModelRegistry.get(input.model);
    if (!model.extendEndpoint) throw new ApiError(400, 'UNSUPPORTED_OPERATION', `Model ${model.id} does not support video extension.`, { model: model.id, operation: 'extend' });
    const form = new FormData();
    form.append('prompt', input.prompt);
    form.append('ref_history', input.source_uuid);
    const raw = asRecord(await this.request(model.extendEndpoint, { method: 'POST', body: form }, requestId, 'extendVideo', {
      model: model.id, provider: 'snapgen', inputMode: 'extend',
    }));
    const uuid = requiredString(responseUuid(raw), 'uuid or conversion_uuid');
    return { uuid, status: 'processing', provider: 'snapgen', operation: 'extend', model: model.id };
  }

  async createStoryboard(input: StoryboardInput, requestId: string): Promise<VideoOperation> {
    const form = new FormData();
    form.append('scenes', JSON.stringify(input.scenes.map((scene) => ({ ...scene, mode: 'custom' }))));
    form.append('aspect_ratio', input.aspect_ratio);
    form.append('resolution', input.resolution);
    form.append('model', input.model);
    const raw = asRecord(await this.request('/uapi/v1/video-storyboard/grok', { method: 'POST', body: form }, requestId, 'createStoryboard', {
      model: input.model, provider: 'snapgen', inputMode: 'storyboard',
    }));
    const uuid = requiredString(responseUuid(raw), 'uuid or conversion_uuid');
    return { uuid, status: 'processing', provider: 'snapgen', operation: 'storyboard', model: input.model };
  }

  private async getWithRetry(path: string, requestId: string): Promise<unknown> {
    const delays = [100, 250];
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.request(path, { method: 'GET' }, requestId, 'getVideoStatus', { provider: 'snapgen', attempt: attempt + 1 });
      } catch (error) {
        const retryable = error instanceof SnapGenError && (error.status === 429 || error.status >= 500);
        if (!retryable || attempt >= delays.length) throw error;
        await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
      }
    }
  }

  private async request(
    path: string,
    init: RequestInit,
    requestId: string,
    operation: string,
    context: Record<string, unknown> = {},
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.env.SNAPGEN_TIMEOUT_MS);
    const startedAt = performance.now();
    try {
      const response = await this.fetchImplementation(`${this.env.SNAPGEN_BASE_URL}${path}`, {
        ...init,
        headers: { 'x-api-key': this.env.SNAPGEN_API_KEY, 'x-request-id': requestId },
        signal: controller.signal,
      });
      const body = redact(await responseBody(response), [this.env.SNAPGEN_API_KEY, this.env.MIDDLEWARE_API_KEY]);
      const bodyRecord = asRecord(body);
      const upstreamStatusValue = bodyRecord.status;
      const upstreamStatusType = upstreamStatusValue === null ? 'null' : Array.isArray(upstreamStatusValue) ? 'array' : typeof upstreamStatusValue;
      const safeStatusValue = ['string', 'number', 'boolean'].includes(typeof upstreamStatusValue) ? upstreamStatusValue : undefined;
      const generationUuid = responseUuid(bodyRecord);
      this.logger.info({
        event: 'snapgen_request',
        requestId,
        operation,
        ...context,
        upstreamStatus: response.status,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        responseKeys: Object.keys(bodyRecord),
        statusType: upstreamStatusType,
        ...(safeStatusValue !== undefined ? { upstreamStatusValue: safeStatusValue } : {}),
        ...(generationUuid ? { generationUuid } : {}),
      });
      if (!response.ok) throw new SnapGenError(response.status, body);
      return body;
    } catch (error) {
      if (error instanceof SnapGenError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        this.logger.error({ event: 'snapgen_request', requestId, operation, ...context, upstreamStatus: null, durationMs: Math.round((performance.now() - startedAt) * 100) / 100, error: 'timeout' });
        throw new SnapGenError(504, undefined, 'SnapGen request timeout');
      }
      this.logger.error({ event: 'snapgen_request', requestId, operation, ...context, upstreamStatus: null, durationMs: Math.round((performance.now() - startedAt) * 100) / 100, error: 'network_error' });
      throw new SnapGenError(502, { message: 'Unable to reach SnapGen' });
    } finally {
      clearTimeout(timeout);
    }
  }
}
