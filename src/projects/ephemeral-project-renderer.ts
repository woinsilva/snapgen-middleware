import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ApiError } from '../errors.js';
import type { VideoProvider } from '../providers/video.provider.js';
import type { FfmpegMediaProcessor } from '../media/ffmpeg-media-processor.js';
import type { SecureMediaDownloader } from '../media/secure-media-downloader.js';
import type { ValidatedProjectState } from './project.schemas.js';
import type { ProjectRenderer, RenderResult } from './project.service.js';
import type { EphemeralOutputStore } from './project-output-store.js';
import type { Logger } from '../utils/logger.js';
import { processIdentity } from '../runtime/process-identity.js';

const silentLogger: Logger = { info: () => undefined, error: () => undefined };

export class EphemeralProjectRenderer implements ProjectRenderer {
  constructor(
    private readonly provider: VideoProvider,
    private readonly downloader: SecureMediaDownloader,
    private readonly processor: FfmpegMediaProcessor,
    private readonly outputs: EphemeralOutputStore,
    private readonly outputTtlSeconds = 900,
    private readonly logger: Logger = silentLogger,
  ) {}

  async render(state: ValidatedProjectState, requestId: string, options: { signal?: AbortSignal; renderJobId?: string } = {}): Promise<RenderResult> {
    const workdir = await mkdtemp(join(tmpdir(), `snapgen-v3-${state.projectId}-`));
    const context = { ...processIdentity, projectId: state.projectId, renderJobId: options.renderJobId, requestId };
    const stage = async <T>(renderStage: string, action: () => Promise<T>, sceneSequence?: number): Promise<T> => {
      const startedAt = performance.now();
      this.logger.info({ event: 'render_stage', lifecycle: 'started', renderStage, sceneSequence, ...context });
      try {
        const result = await action();
        this.logger.info({ event: 'render_stage', lifecycle: 'completed', renderStage, sceneSequence, elapsedMs: Math.round(performance.now() - startedAt), ...context });
        return result;
      } catch (error) {
        this.logger.error({ event: 'render_stage', lifecycle: 'failed', renderStage, sceneSequence, elapsedMs: Math.round(performance.now() - startedAt), errorCode: error instanceof ApiError ? error.code : 'RENDER_STAGE_FAILED', ...context });
        throw error;
      }
    };
    try {
      const normalized: string[] = [];
      for (const scene of state.scenes) {
        options.signal?.throwIfAborted();
        if (!scene.snapgenUuid) throw new ApiError(409, 'SCENE_UUID_MISSING', `Scene ${scene.sequence} has no provider UUID.`);
        const status = await stage('provider_status', () => this.provider.getVideo(scene.snapgenUuid!, requestId), scene.sequence);
        options.signal?.throwIfAborted();
        if (status.status !== 'completed' || !status.videoUrl) throw new ApiError(409, 'SCENE_MEDIA_UNAVAILABLE', `Scene ${scene.sequence} media is not currently available.`);
        const input = join(workdir, `scene-${scene.sequence}-source.mp4`);
        const output = join(workdir, `scene-${scene.sequence}-normalized.mp4`);
        await stage('media_download', () => this.downloader.download(status.videoUrl!, input, options.signal), scene.sequence);
        await stage('ffmpeg_normalize', () => this.processor.normalize(input, output, state.resolution, state.segmentDuration, options.signal), scene.sequence);
        normalized.push(output);
      }
      const manifest = join(workdir, 'concat.txt');
      const concatenated = join(workdir, 'concatenated.mp4');
      const final = join(workdir, 'final.mp4');
      await stage('ffmpeg_concatenate', () => this.processor.concatenate(normalized, manifest, concatenated, options.signal));
      await stage('ffmpeg_finalize', () => this.processor.finalize(concatenated, final, state.targetDuration, options.signal));
      options.signal?.throwIfAborted();
      return await stage('output_store', () => this.outputs.store(final, this.outputTtlSeconds));
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  }
}
