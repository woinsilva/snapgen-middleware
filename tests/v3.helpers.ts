import type { CreateProjectInput, ValidatedProjectState } from '../src/projects/project.schemas.js';
import { ProjectStateTokenService } from '../src/projects/project-state-token.js';
import { StatelessProjectService } from '../src/projects/project.service.js';
import type { VideoProvider } from '../src/providers/video.provider.js';

export const tokenSecret = 'v3-test-secret-that-is-at-least-32-characters-long';

export function projectInput(duration = 70): CreateProjectInput {
  const count = Math.ceil(duration / 8);
  return {
    concept: 'A child-friendly forest adventure',
    model: 'veo-3.1-fast',
    duration,
    resolution: '1080p',
    aspect_ratio: '16:9',
    visualBible: {
      style: 'Cinematic 2D animation',
      characters: [{ id: 'lia', description: 'Young explorer with a yellow backpack' }],
      environment: 'A warm enchanted forest',
      continuityRules: ['Keep Lia and her backpack visually consistent'],
    },
    scenes: Array.from({ length: count }, (_, index) => ({
      sequence: index + 1,
      prompt: `Scene ${index + 1}: Lia walks deeper into the forest.`,
      continuityInstructions: 'Preserve character, direction, lighting and environment.',
    })),
  };
}

export function testTokens(now = new Date('2026-09-14T12:00:00.000Z'), max = 65_536) {
  return new ProjectStateTokenService(tokenSecret, undefined, max, () => now);
}

export function serviceWith(provider: VideoProvider, now = new Date('2026-09-14T12:00:00.000Z')) {
  const tokens = testTokens(now);
  return { service: new StatelessProjectService(tokens, provider, undefined, 86_400, () => now), tokens };
}

export function decodeState(service: StatelessProjectService, response: { projectState: string }): ValidatedProjectState {
  return service.verify(response.projectState);
}
