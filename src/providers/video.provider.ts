import type { VideoGenerateInput } from '../schemas/video.schema.js';

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

export interface VideoProvider {
  generateVideo(input: VideoGenerateInput, requestId: string): Promise<VideoGeneration>;
  getVideo(uuid: string, requestId: string): Promise<VideoGenerationStatus>;
}
