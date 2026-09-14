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
});
