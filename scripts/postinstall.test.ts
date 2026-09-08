import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryDirectories: string[] = [];
const postinstallPath = fileURLToPath(new URL('./postinstall.mjs', import.meta.url));

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createInstalledPackage(prismaCli: string) {
  const directory = mkdtempSync(join(tmpdir(), 'postinstall with spaces '));
  temporaryDirectories.push(directory);
  const packageRoot = join(directory, 'node_modules', 'factory-factory');
  const prismaRoot = join(directory, 'node_modules', 'prisma');
  mkdirSync(join(packageRoot, 'scripts'), { recursive: true });
  mkdirSync(join(packageRoot, 'prisma'), { recursive: true });
  mkdirSync(join(prismaRoot, 'build'), { recursive: true });
  copyFileSync(postinstallPath, join(packageRoot, 'scripts', 'postinstall.mjs'));
  writeFileSync(join(packageRoot, 'prisma', 'schema.prisma'), '// fixture schema');
  // Match Prisma's CLI export: its root export is not the CLI entry point.
  writeFileSync(
    join(prismaRoot, 'package.json'),
    JSON.stringify({
      name: 'prisma',
      type: 'module',
      exports: { '.': './build/types.js', './build/index.js': './build/index.js' },
      bin: { prisma: './build/index.js' },
    })
  );
  writeFileSync(join(prismaRoot, 'build', 'index.js'), prismaCli);
  return packageRoot;
}

function runPostinstall(packageRoot: string) {
  return spawnSync(process.execPath, [join(packageRoot, 'scripts', 'postinstall.mjs')], {
    cwd: tmpdir(),
    // A nested npm/npx invocation must not be needed during installation.
    env: { PATH: '' },
    encoding: 'utf8',
    timeout: 5000,
  });
}

describe('postinstall Prisma generation', () => {
  it('runs the installed Prisma CLI without npm or npx on PATH', () => {
    const packageRoot = createInstalledPackage(`
import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
assert.deepEqual(process.argv.slice(2), ['generate', '--schema', join(process.cwd(), 'prisma', 'schema.prisma')]);
assert.equal(readFileSync(process.argv[4], 'utf8'), '// fixture schema');
writeFileSync(join(process.cwd(), 'prisma', 'generated.txt'), 'generated');
`);

    const result = runPostinstall(packageRoot);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(readFileSync(join(packageRoot, 'prisma', 'generated.txt'), 'utf8')).toBe('generated');
  });

  it('reports Prisma generation failures without failing installation', () => {
    const packageRoot = createInstalledPackage(`
console.error('fixture Prisma generation failed');
process.exitCode = 1;
`);

    const result = runPostinstall(packageRoot);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('fixture Prisma generation failed');
    expect(result.stderr).toContain('Failed to generate Prisma client:');
  });
});
