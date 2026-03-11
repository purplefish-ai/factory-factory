import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const handlersDir = __dirname;

const HANDLERS = [
  'user-input.handler.ts',
  'set-model.handler.ts',
  'permission-response.handler.ts',
] as const;

describe('session handler import boundary', () => {
  test.each(HANDLERS)('%s does not import directly from session domain internals', (fileName) => {
    const source = readFileSync(join(handlersDir, fileName), 'utf8');
    const importSpecifiers = Array.from(source.matchAll(/from\s+['"]([^'"]+)['"]/g)).map(
      (match) => match[1]
    );

    expect(importSpecifiers).not.toContain('@/backend/services/session');
    expect(importSpecifiers).not.toContain(
      '@/backend/services/session/service/lifecycle/session.service'
    );
    expect(importSpecifiers).not.toContain(
      '@/backend/services/session/service/session-domain.service'
    );
  });
});
