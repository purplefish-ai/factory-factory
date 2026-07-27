import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const scriptPath = fileURLToPath(
  new URL('../../../scripts/check-prisma-versions.mjs', import.meta.url)
);

describe('check-prisma-versions script', () => {
  let tempRoot: string | null = null;

  afterEach(() => {
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = null;
    }
  });

  function run(dependencies: Record<string, string>) {
    tempRoot = mkdtempSync(join(tmpdir(), 'ff-prisma-versions-'));
    const manifestPath = join(tempRoot, 'package.json');
    writeFileSync(
      manifestPath,
      `${JSON.stringify({ dependencies, devDependencies: {} }, null, 2)}\n`,
      'utf8'
    );

    return spawnSync('node', [scriptPath, manifestPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  const alignedDependencies = {
    '@prisma/adapter-better-sqlite3': '7.9.0',
    '@prisma/client': '7.9.0',
    prisma: '7.9.0',
  };

  it('accepts aligned runtime dependencies without devDependencies.prisma', () => {
    const result = run(alignedDependencies);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Prisma dependencies are pinned to 7.9.0.');
  });

  it('rejects a missing runtime Prisma dependency', () => {
    const { prisma: _prisma, ...dependencies } = alignedDependencies;
    const result = run(dependencies);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('prisma must be pinned exactly in dependencies, got undefined');
  });

  it('rejects a ranged Prisma version', () => {
    const result = run({ ...alignedDependencies, prisma: '^7.9.0' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('prisma must be pinned exactly in dependencies, got ^7.9.0');
  });

  it('rejects mismatched exact Prisma versions', () => {
    const result = run({ ...alignedDependencies, prisma: '7.9.1' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Prisma versions must match: @prisma/adapter-better-sqlite3=7.9.0, @prisma/client=7.9.0, prisma=7.9.1'
    );
  });
});
