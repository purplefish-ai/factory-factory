import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findProcessEnvViolations } from '@/../scripts/check-no-direct-process-env.mjs';

describe('check-no-direct-process-env script', () => {
  let tempRoot: string | null = null;

  afterEach(() => {
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = null;
    }
  });

  it('flags direct process.env usage outside the allowlist', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'ff-env-check-'));
    const backendDir = join(tempRoot, 'src', 'backend');
    mkdirSync(join(backendDir, 'services'), { recursive: true });
    mkdirSync(join(backendDir, 'feature'), { recursive: true });

    writeFileSync(
      join(backendDir, 'services', 'config.service.ts'),
      'export const config = process.env;',
      'utf8'
    );
    writeFileSync(
      join(backendDir, 'feature', 'service.ts'),
      'export const value = process.env.MY_FLAG;',
      'utf8'
    );
    writeFileSync(
      join(backendDir, 'feature', 'service.test.ts'),
      'process.env.TEST_ONLY = "1";',
      'utf8'
    );

    const violations = findProcessEnvViolations({
      rootDir: tempRoot,
      allowlistedFiles: new Set(['src/backend/services/config.service.ts']),
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe('src/backend/feature/service.ts');
  });
});
