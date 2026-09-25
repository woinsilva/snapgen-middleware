import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('OpenAPI contract', () => {
  it('documents the public privacy policy as HTML', async () => {
    const document = await readFile(new URL('../openapi.yaml', import.meta.url), 'utf8');

    expect(document.replaceAll('\r\n', '\n')).toContain(`  /privacy:
    get:
      operationId: getPrivacyPolicy
      x-openai-isConsequential: false
      summary: Get the public privacy policy
      description: Returns the middleware privacy policy as an HTML document.
      security: []
      responses:
        '200':
          description: Privacy policy HTML
          content:
            text/html:`);
  });

  it('documents internal stateless V3 endpoints without changing the published Custom GPT artifact', async () => {
    const document = await readFile(new URL('../openapi.yaml', import.meta.url), 'utf8');
    const published = await readFile(new URL('../custom-gpt-v2-final/OPENAPI-FINAL.yaml', import.meta.url), 'utf8');
    expect(document).toContain('/video/projects/start:');
    expect(document).toContain('/video/projects/advance:');
    expect(document).toContain('/video/projects/status:');
    expect(document).toContain('/video/projects/generation:');
    expect(document).toContain('/video/projects/{projectId}/generation/{generationJobId}:');
    expect(document).toContain('/video/projects/continue:');
    expect(document).toContain('/video/projects/render:');
    expect(document).toContain('/video/projects/output/{projectId}:');
    expect(published).not.toContain('/video/projects/start:');
  });

  it('provides a V1/V2/V3 GPT Actions contract with JSON-only actions and unique operation IDs', async () => {
    const canonical = await readFile(new URL('../openapi-gpt.yaml', import.meta.url), 'utf8');
    const document = await readFile(new URL('../custom-gpt-v3-final/OPENAPI-FINAL.yaml', import.meta.url), 'utf8');
    expect(canonical.replaceAll('\r\n', '\n').trimEnd()).toBe(document.replaceAll('\r\n', '\n').trimEnd());
    const operationIds = [...document.matchAll(/^\s+operationId:\s+(\S+)\s*$/gm)].map((match) => match[1]);
    expect(operationIds).toEqual([
      'healthCheck', 'generateVideo', 'getVideoModels', 'extendVideo', 'generateStoryboard',
      'startVideoProject', 'startVideoProjectGeneration', 'getVideoProjectGenerationStatus', 'renderVideoProject', 'getVideoProjectRenderStatus',
      'getVideoGenerationStatus',
    ]);
    expect(new Set(operationIds).size).toBe(operationIds.length);
    expect(document).toContain('/video/projects/{projectId}/render/{renderJobId}:');
    expect(document).not.toContain('/video/projects/continue:');
    expect(document).not.toContain('/video/projects/advance:');
    expect(document).not.toContain('/video/projects/status:');
    expect(document).not.toContain('/video/projects/output/{projectId}:');
    expect(document).not.toContain('video/mp4');
    expect(document).toContain("aspect_ratio: '16:9'");
    expect(document).toContain('enum: ["720p", "1080p"]');
  });

  it('marks only potentially paid GPT Actions as consequential', async () => {
    const document = await readFile(new URL('../custom-gpt-v3-final/OPENAPI-FINAL.yaml', import.meta.url), 'utf8');
    const operationFlags = new Map<string, boolean>();
    for (const match of document.matchAll(/operationId:\s+(\S+)\s*\n\s+x-openai-isConsequential:\s+(true|false)/g)) {
      operationFlags.set(match[1]!, match[2] === 'true');
    }
    expect([...operationFlags.entries()].filter(([, consequential]) => consequential).map(([id]) => id)).toEqual([
      'generateVideo', 'extendVideo', 'generateStoryboard', 'startVideoProjectGeneration',
    ]);
    expect(operationFlags.get('startVideoProject')).toBe(false);
    expect(operationFlags.get('getVideoProjectGenerationStatus')).toBe(false);
    expect(operationFlags.get('renderVideoProject')).toBe(false);
    expect(operationFlags.get('getVideoProjectRenderStatus')).toBe(false);
  });
});
