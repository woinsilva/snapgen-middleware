import { ApiError } from '../errors.js';
import type { ProjectModelProfile } from './project.domain.js';

const profiles: ProjectModelProfile[] = [
  {
    model: 'veo-3.1-fast',
    segmentDurationSeconds: 8,
    supportsLongProject: true,
    supportsExtend: true,
    extendChainValidated: false,
    generationStrategy: 'last-frame-chained',
    allowedResolutions: ['720p', '1080p'],
    allowedAspectRatios: ['16:9'],
  },
];

export class ProjectModelProfileRegistry {
  private readonly profiles = new Map(profiles.map((profile) => [profile.model, Object.freeze(profile)]));

  get(model: string): ProjectModelProfile {
    const profile = this.profiles.get(model);
    if (!profile || !profile.supportsLongProject) {
      throw new ApiError(400, 'UNSUPPORTED_PROJECT_MODEL', `Model ${model} does not support long video projects.`);
    }
    return profile;
  }

  list(): ProjectModelProfile[] {
    return [...this.profiles.values()];
  }
}

export const projectModelProfileRegistry = new ProjectModelProfileRegistry();
