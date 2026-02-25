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

    expect(source).not.toContain("from '@/backend/domains/session'");
    expect(source).not.toContain("from '@/backend/domains/session/lifecycle/session.service'");
    expect(source).not.toContain("from '@/backend/domains/session/session-domain.service'");
  });
});
