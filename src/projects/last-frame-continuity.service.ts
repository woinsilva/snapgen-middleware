import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ApiError } from '../errors.js';
import type { SecureMediaDownloader } from '../media/secure-media-downloader.js';
import type { FfmpegMediaProcessor } from '../media/ffmpeg-media-processor.js';
import type { VideoProvider } from '../providers/video.provider.js';
import type { ValidatedProjectState } from './project.schemas.js';
import type { ProjectStateTokenService } from './project-state-token.js';
import type { EphemeralContinuityFrameStore } from './project-continuity-frame-store.js';

export interface SceneReferenceResolver {
  referenceImages(state: ValidatedProjectState, nextSceneSequence: number, requestId: string): Promise<string[]>;
}

export class LastFrameContinuityService implements SceneReferenceResolver {
  constructor(
    private readonly provider: VideoProvider,
    private readonly downloader: SecureMediaDownloader,
    private readonly processor: FfmpegMediaProcessor,
    private readonly frames: EphemeralContinuityFrameStore,
    private readonly tokens: ProjectStateTokenService,
    private readonly publicBaseUrl: string,
    private readonly frameTtlSeconds = 3_600,
  ) {}

  async referenceImages(state: ValidatedProjectState, nextSceneSequence: number, requestId: string): Promise<string[]> {
    if (nextSceneSequence <= 1) return [];
    const previous = state.scenes.find((scene) => scene.sequence === nextSceneSequence - 1);
    if (!previous || previous.status !== 'completed' || !previous.snapgenUuid) {
      throw new ApiError(409, 'CONTINUITY_SOURCE_NOT_READY', `Scene ${nextSceneSequence - 1} must be completed before scene ${nextSceneSequence} can start.`);
    }
    const statusLookup = this.provider.getVideoOnce?.bind(this.provider) ?? this.provider.getVideo.bind(this.provider);
    const status = await statusLookup(previous.snapgenUuid, `${requestId}:continuity-source`);
    if (status.status !== 'completed' || !status.videoUrl) {
      throw new ApiError(409, 'CONTINUITY_SOURCE_UNAVAILABLE', `Scene ${nextSceneSequence - 1} has no downloadable media for continuity.`);
    }

    const workdir = await mkdtemp(join(tmpdir(), `snapgen-continuity-${state.projectId}-`));
    try {
      const video = join(workdir, 'source.mp4');
      const image = join(workdir, 'final-frame.png');
      await this.downloader.download(status.videoUrl, video);
      await this.processor.extractFinalFrame(video, image);
      const frame = await this.frames.store(image, this.frameTtlSeconds);
      const access = this.tokens.signFrameAccess(state.projectId, frame);
      const url = new URL(`/video/projects/frames/${state.projectId}`, this.publicBaseUrl);
      url.searchParams.set('access', access);
      return [url.toString()];
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  }
}
