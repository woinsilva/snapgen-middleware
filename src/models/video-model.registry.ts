import { ApiError } from '../errors.js';
import type { VideoGenerateInput } from '../schemas/video.schema.js';

export type VideoFamily = 'veo' | 'grok' | 'seedance' | 'kling' | 'flux' | 'minimax';

export interface VideoModelDefinition {
  id: string;
  family: VideoFamily;
  endpoint: string;
  extendEndpoint?: string;
  resolutions: string[];
  aspectRatios: string[];
  durations: number[] | { min: number; max: number };
  modes?: string[];
  defaults: { duration: number; resolution?: string; aspectRatio: string; mode?: string };
  maxRefImages: number;
  referenceField: 'ref_images' | 'file_urls';
  includeModel: boolean;
  includeResolution: boolean;
  supportsModeImage?: boolean;
  supportsSkipAudio?: boolean;
}

const veo = (id: string, overrides: Partial<VideoModelDefinition> = {}): VideoModelDefinition => ({
  id, family: 'veo', endpoint: '/uapi/v1/video-gen/veo', extendEndpoint: '/uapi/v1/video-extend/veo',
  resolutions: ['720p', '1080p'], aspectRatios: ['16:9'], durations: [8],
  defaults: { duration: 8, resolution: '720p', aspectRatio: '16:9' }, maxRefImages: 3,
  referenceField: 'ref_images', includeModel: true, includeResolution: true, supportsModeImage: true, ...overrides,
});

const seedance = (id: string, modes: string[], maxDuration: number, maxRefImages: number): VideoModelDefinition => ({
  id, family: 'seedance', endpoint: '/uapi/v1/video-gen/seedance', extendEndpoint: '/uapi/v1/video-extend/seedance',
  resolutions: ['720p'], aspectRatios: ['16:9', '9:16', '1:1', '3:4', '4:3', '21:9'], durations: { min: 4, max: maxDuration },
  modes, defaults: { duration: 4, resolution: '720p', aspectRatio: '16:9', mode: modes[0] }, maxRefImages,
  referenceField: 'ref_images', includeModel: true, includeResolution: true,
});

const kling = (id: string, modes: string[], durations: VideoModelDefinition['durations']): VideoModelDefinition => ({
  id, family: 'kling', endpoint: '/uapi/v1/video-gen/kling', resolutions: ['720p', '1080p'],
  aspectRatios: ['16:9', '9:16', '1:1'], durations, modes,
  defaults: { duration: typeof durations === 'object' && !Array.isArray(durations) ? 5 : durations[0]!, resolution: '720p', aspectRatio: '16:9', mode: 'standard' },
  maxRefImages: 4, referenceField: 'ref_images', includeModel: true, includeResolution: false,
});

const definitions: VideoModelDefinition[] = [
  veo('veo-3.1'), veo('veo-3.1-fast'), veo('veo-3.1-lite'),
  veo('veo-2', { resolutions: ['720p'], aspectRatios: ['16:9', '9:16'], durations: [8] }),
  veo('omni-flash', { extendEndpoint: undefined, aspectRatios: ['16:9', '9:16'], durations: [4, 6, 8, 10] }),
  { id: 'grok-3', family: 'grok', endpoint: '/uapi/v1/video-gen/grok', extendEndpoint: '/uapi/v1/video-extend/grok',
    resolutions: ['480p', '720p'], aspectRatios: ['landscape', 'portrait', 'square', 'vertical', 'horizontal'], durations: [6, 10, 15],
    modes: ['custom', 'normal', 'extremely-crazy', 'extremely-spicy-or-crazy'], defaults: { duration: 6, resolution: '480p', aspectRatio: 'landscape', mode: 'custom' },
    maxRefImages: 5, referenceField: 'file_urls', includeModel: true, includeResolution: true, supportsSkipAudio: true },
  { id: 'grok-lower', family: 'grok', endpoint: '/uapi/v1/video-gen/grok-lower',
    resolutions: ['480p', '720p', '1080p'], aspectRatios: ['landscape', 'portrait', 'square', '3:2', '2:3'], durations: [6, 10, 15],
    modes: ['custom', 'normal', 'extremely-crazy', 'extremely-spicy-or-crazy'], defaults: { duration: 6, resolution: '480p', aspectRatio: 'landscape', mode: 'custom' },
    maxRefImages: 5, referenceField: 'file_urls', includeModel: false, includeResolution: true, supportsSkipAudio: true },
  seedance('seedance-2', ['fast', 'pro'], 15, 2),
  seedance('seedance-2-omni', ['fast', 'pro', 'fast-vip', 'pro-vip'], 15, 4),
  seedance('seedance-2-mini', ['business_mini'], 15, 2),
  seedance('seedance-2-5-omni', ['cheap', 'pro-vip'], 30, 14),
  { id: 'flux-3', family: 'flux', endpoint: '/uapi/v1/video-gen/flux', resolutions: [],
    aspectRatios: ['16:9', '9:16', '1:1', '3:4', '4:3', '2:1', '21:9'], durations: { min: 5, max: 20 }, modes: ['vip'],
    defaults: { duration: 10, aspectRatio: '16:9', mode: 'vip' }, maxRefImages: 10, referenceField: 'ref_images', includeModel: true, includeResolution: false },
  { id: 'minimax-h3', family: 'minimax', endpoint: '/uapi/v1/video-gen/minimax', resolutions: [],
    aspectRatios: ['16:9', '9:16', '1:1', '3:4', '4:3', '21:9'], durations: { min: 5, max: 15 }, modes: ['standard'],
    defaults: { duration: 8, aspectRatio: '16:9', mode: 'standard' }, maxRefImages: 9, referenceField: 'ref_images', includeModel: true, includeResolution: false },
  kling('kling-video-3-0', ['standard', 'professional'], { min: 3, max: 15 }),
  kling('kling-video-2-6', ['standard', 'professional', 'professional_audio'], { min: 3, max: 15 }),
  kling('kling-video-o1', ['standard', 'professional'], { min: 3, max: 15 }),
  kling('kling-video-2-5', ['relax', 'standard', 'professional'], { min: 3, max: 15 }),
  kling('kling-video-2-1-10s', ['standard', 'professional'], [10]),
  kling('kling-video-2-1-5s', ['standard', 'professional'], [5]),
  kling('kling-video-1-6-10s', ['standard', 'professional'], [10]),
  kling('kling-video-1-6-5s', ['standard', 'professional'], [5]),
];

export interface ResolvedVideoInput extends VideoGenerateInput {
  duration: number;
  aspect_ratio: string;
  resolution?: string;
  mode?: string;
}

function fail(field: string, message: string, code = 'VALIDATION_ERROR'): never {
  throw new ApiError(400, code, message, [{ field, message }]);
}

export class VideoModelRegistry {
  private readonly models = new Map(definitions.map((definition) => [definition.id, definition]));

  get(modelId: string): VideoModelDefinition {
    const model = this.models.get(modelId);
    if (!model) throw new ApiError(400, 'UNSUPPORTED_MODEL', 'The requested model is not supported.', { model: modelId });
    return model;
  }

  resolve(input: VideoGenerateInput): { model: VideoModelDefinition; input: ResolvedVideoInput } {
    const model = this.get(input.model);
    const duration = input.duration ?? model.defaults.duration;
    const aspectRatio = input.aspect_ratio ?? model.defaults.aspectRatio;
    const mode = input.mode ?? model.defaults.mode;
    const klingResolution = mode === 'professional' || mode === 'professional_audio' ? '1080p' : '720p';
    const resolution = input.resolution ?? (model.family === 'kling' ? klingResolution : model.defaults.resolution);
    const durationValid = Array.isArray(model.durations)
      ? model.durations.includes(duration)
      : duration >= model.durations.min && duration <= model.durations.max;
    if (!durationValid) fail('duration', `Model ${model.id} does not support duration ${duration}`);
    if (!model.aspectRatios.includes(aspectRatio)) fail('aspect_ratio', `Model ${model.id} does not support aspect ratio ${aspectRatio}`);
    if (resolution && !model.resolutions.includes(resolution)) fail('resolution', `Model ${model.id} does not support resolution ${resolution}`);
    if (input.resolution && model.resolutions.length === 0) fail('resolution', `Model ${model.id} does not accept a resolution parameter`);
    if (input.mode && (!model.modes || !model.modes.includes(input.mode))) fail('mode', `Model ${model.id} does not support mode ${input.mode}`);
    if (input.mode_image && !model.supportsModeImage) fail('mode_image', `Model ${model.id} does not support mode_image`);
    if (input.skip_audio !== undefined && !model.supportsSkipAudio) fail('skip_audio', `Model ${model.id} does not support skip_audio`);
    const maxImages = model.family === 'veo' && (input.mode_image ?? 'frame') === 'frame' ? 2 : model.maxRefImages;
    if (input.ref_images.length > maxImages) fail('ref_images', `Model ${model.id} accepts at most ${maxImages} reference images`);
    if (model.family === 'kling' && resolution) {
      const expected = mode === 'professional' || mode === 'professional_audio' ? '1080p' : '720p';
      if (resolution !== expected) fail('resolution', `Kling mode ${mode} produces ${expected}, not ${resolution}`);
    }
    return { model, input: { ...input, duration, aspect_ratio: aspectRatio, resolution, mode } };
  }

  list() {
    return definitions.map((model) => ({
      id: model.id, family: model.family, supportsTextToVideo: true, supportsImageToVideo: model.maxRefImages > 0,
      supportsExtend: Boolean(model.extendEndpoint), resolutions: model.resolutions, aspectRatios: model.aspectRatios,
      durations: model.durations, modes: model.modes ?? [], maxReferenceImages: model.maxRefImages,
    }));
  }
}

export const videoModelRegistry = new VideoModelRegistry();
