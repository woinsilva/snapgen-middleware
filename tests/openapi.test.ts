import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('OpenAPI contract', () => {
  it('documents the public privacy policy as HTML', async () => {
    const document = await readFile(new URL('../openapi.yaml', import.meta.url), 'utf8');

    expect(document.replaceAll('\r\n', '\n')).toContain(`  /privacy:
    get:
      operationId: getPrivacyPolicy
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
    expect(document).toContain('/video/projects/continue:');
    expect(document).toContain('/video/projects/render:');
    expect(document).toContain('/video/projects/output/{projectId}:');
    expect(published).not.toContain('/video/projects/start:');
  });
});
