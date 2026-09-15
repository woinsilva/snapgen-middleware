import type { StoryboardInput, VideoExtendInput, VideoGenerateInput } from '../schemas/video.schema.js';

export interface VideoGeneration {
  uuid: string;
  status: 'processing';
  provider: 'snapgen';
  model: string;
}

export interface VideoGenerationStatus {
  uuid: string;
  status: 'processing' | 'completed' | 'failed';
  progress: number;
  videoUrl: string | null;
  provider: 'snapgen';
  error?: string;
}

export interface VideoOperation {
  uuid: string;
  status: 'processing';
  provider: 'snapgen';
  operation: 'extend' | 'storyboard';
  model: string;
}

export interface VideoProvider {
  generateVideo(input: VideoGenerateInput, requestId: string): Promise<VideoGeneration>;
  getVideo(uuid: string, requestId: string): Promise<VideoGenerationStatus>;
  getVideoOnce?(uuid: string, requestId: string): Promise<VideoGenerationStatus>;
  extendVideo(input: VideoExtendInput, requestId: string): Promise<VideoOperation>;
  createStoryboard(input: StoryboardInput, requestId: string): Promise<VideoOperation>;
}
