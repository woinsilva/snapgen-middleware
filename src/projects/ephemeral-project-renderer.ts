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

export class EphemeralProjectRenderer implements ProjectRenderer {
  constructor(
    private readonly provider: VideoProvider,
    private readonly downloader: SecureMediaDownloader,
    private readonly processor: FfmpegMediaProcessor,
    private readonly outputs: EphemeralOutputStore,
    private readonly outputTtlSeconds = 900,
  ) {}

  async render(state: ValidatedProjectState, requestId: string): Promise<RenderResult> {
    const workdir = await mkdtemp(join(tmpdir(), `snapgen-v3-${state.projectId}-`));
    try {
      const normalized: string[] = [];
      for (const scene of state.scenes) {
        if (!scene.snapgenUuid) throw new ApiError(409, 'SCENE_UUID_MISSING', `Scene ${scene.sequence} has no provider UUID.`);
        const status = await this.provider.getVideo(scene.snapgenUuid, requestId);
        if (status.status !== 'completed' || !status.videoUrl) throw new ApiError(409, 'SCENE_MEDIA_UNAVAILABLE', `Scene ${scene.sequence} media is not currently available.`);
        const input = join(workdir, `scene-${scene.sequence}-source.mp4`);
        const output = join(workdir, `scene-${scene.sequence}-normalized.mp4`);
        await this.downloader.download(status.videoUrl, input);
        await this.processor.normalize(input, output, state.resolution, state.segmentDuration);
        normalized.push(output);
      }
      const manifest = join(workdir, 'concat.txt');
      const concatenated = join(workdir, 'concatenated.mp4');
      const final = join(workdir, 'final.mp4');
      await this.processor.concatenate(normalized, manifest, concatenated);
      await this.processor.finalize(concatenated, final, state.targetDuration);
      return await this.outputs.store(final, this.outputTtlSeconds);
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  }
}
