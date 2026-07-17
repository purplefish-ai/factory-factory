import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

describe('check-service-registry root infrastructure classification', () => {
  const unclassifiedPath = path.join(
    process.cwd(),
    'src/backend/services/unclassified-registry-test.service.ts'
  );

  afterEach(() => rmSync(unclassifiedPath, { force: true }));

  it('rejects a root service that is not explicitly registered as infrastructure', () => {
    writeFileSync(unclassifiedPath, 'export const marker = true;\n');
    const result = spawnSync('pnpm', ['check:service-registry'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(
      'unclassified-registry-test.service.ts is a root service that is not registered as infrastructure'
    );
  }, 30_000);
});
