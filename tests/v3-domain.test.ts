import { describe, expect, it } from 'vitest';
import {
  assertProjectTransition,
  assertSceneTransition,
  calculateProjectBudget,
  calculateProjectProgress,
  calculateRawDuration,
  calculateSegmentCount,
  calculateTrimDuration,
} from '../src/projects/project.domain.js';
import { projectModelProfileRegistry } from '../src/projects/project-model-profile.registry.js';
import { createProjectSchema } from '../src/projects/project.schemas.js';
import { projectInput } from './v3.helpers.js';

describe('V3 pure project domain', () => {
  it.each([
    [60, 8, 64, 4],
    [70, 9, 72, 2],
    [180, 23, 184, 4],
  ])('calculates %is project segmentation', (duration, count, raw, trim) => {
    expect(calculateSegmentCount(duration, 8)).toBe(count);
    expect(calculateRawDuration(count, 8)).toBe(raw);
    expect(calculateTrimDuration(duration, raw)).toBe(trim);
  });

  it('uses a strict no-retry budget', () => {
    expect(calculateProjectBudget(9)).toEqual({ maxPaidOperations: 9, maxAttemptsPerScene: 1, automaticPaidRetries: 0 });
  });

  it('exposes only the independently generated Veo profile', () => {
    expect(projectModelProfileRegistry.list()).toHaveLength(1);
    expect(projectModelProfileRegistry.get('veo-3.1-fast')).toMatchObject({
      segmentDurationSeconds: 8, supportsExtend: true, extendChainValidated: false, generationStrategy: 'independent',
    });
    expect(() => projectModelProfileRegistry.get('grok-3')).toThrow();
  });

  it('enforces explicit project and scene transitions', () => {
    expect(() => assertProjectTransition('planning', 'generating')).not.toThrow();
    expect(() => assertProjectTransition('planning', 'completed')).toThrow();
    expect(() => assertSceneTransition('pending', 'submitting')).not.toThrow();
    expect(() => assertSceneTransition('completed', 'processing')).toThrow();
  });

  it('calculates bounded progress by state', () => {
    expect(calculateProjectProgress('planning', 0, 9)).toBe(0);
    expect(calculateProjectProgress('generating', 0, 9)).toBe(5);
    expect(calculateProjectProgress('generating', 9, 9)).toBe(89);
    expect(calculateProjectProgress('assembling', 9, 9)).toBe(90);
    expect(calculateProjectProgress('completed', 9, 9)).toBe(100);
  });

  it('accepts exactly nine sequential scenes for 70 seconds', () => {
    expect(createProjectSchema.parse(projectInput(70)).scenes).toHaveLength(9);
  });

  it.each([
    ['scene count', () => ({ ...projectInput(), scenes: projectInput().scenes.slice(0, 8) })],
    ['sequence gaps', () => ({ ...projectInput(), scenes: projectInput().scenes.map((scene, index) => index === 3 ? { ...scene, sequence: 5 } : scene) })],
    ['model', () => ({ ...projectInput(), model: 'unknown' })],
    ['resolution', () => ({ ...projectInput(), resolution: '4k' })],
    ['aspect ratio', () => ({ ...projectInput(), aspect_ratio: '9:16' })],
  ])('rejects invalid %s', (_name, value) => expect(createProjectSchema.safeParse(value()).success).toBe(false));
});
