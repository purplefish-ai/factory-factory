import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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

function createInstalledPackage(prismaCli: string, sourceCheckout = true) {
  const directory = mkdtempSync(join(tmpdir(), 'postinstall with spaces '));
  temporaryDirectories.push(directory);
  const packageRoot = join(directory, 'node_modules', 'factory-factory');
  const prismaRoot = join(directory, 'node_modules', 'prisma');
  mkdirSync(join(packageRoot, 'scripts'), { recursive: true });
  mkdirSync(join(packageRoot, 'prisma'), { recursive: true });
  mkdirSync(join(prismaRoot, 'build'), { recursive: true });
  copyFileSync(postinstallPath, join(packageRoot, 'scripts', 'postinstall.mjs'));
  writeFileSync(join(packageRoot, 'prisma', 'schema.prisma'), '// fixture schema');
  if (sourceCheckout) {
    mkdirSync(join(packageRoot, 'src', 'cli'), { recursive: true });
    writeFileSync(join(packageRoot, 'src', 'cli', 'index.ts'), '// checkout entrypoint');
  } else {
    mkdirSync(join(packageRoot, 'dist', 'prisma', 'generated'), { recursive: true });
    writeFileSync(join(packageRoot, 'dist', 'prisma', 'generated', 'client.js'), '// built client');
  }
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
  it('generates in a source checkout without npm or npx on PATH', () => {
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
    expect(result.stderr).toContain('pnpm db:generate');
  });
});

describe('packaged installation', () => {
  it('uses the shipped runtime client without running the Prisma CLI', () => {
    const packageRoot = createInstalledPackage(
      `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
writeFileSync(join(process.cwd(), 'prisma', 'generated.txt'), 'unexpected generation');
`,
      false
    );

    const result = runPostinstall(packageRoot);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(existsSync(join(packageRoot, 'prisma', 'generated.txt'))).toBe(false);
    expect(
      readFileSync(join(packageRoot, 'dist', 'prisma', 'generated', 'client.js'), 'utf8')
    ).toBe('// built client');
  });

  it.skipIf(process.platform === 'win32').each([
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ])(
    'repairs native helpers (source checkout: %s, local dependency: %s)',
    (sourceCheckout, localDependency) => {
      const packageRoot = createInstalledPackage('', sourceCheckout);
      const helpers = [
        join(
          packageRoot,
          localDependency ? 'node_modules' : '..',
          'node-pty',
          'prebuilds',
          `${process.platform}-${process.arch}`,
          'spawn-helper'
        ),
      ];
      const nativeRoot = join(helpers[0]!, '..', '..', '..');
      mkdirSync(nativeRoot, { recursive: true });
      writeFileSync(
        join(nativeRoot, 'package.json'),
        JSON.stringify({ name: 'node-pty', version: '1.1.0' })
      );
      for (const helper of helpers) {
        mkdirSync(join(helper, '..'), { recursive: true });
        writeFileSync(helper, 'fixture helper');
        chmodSync(helper, 0o644);
      }

      const result = runPostinstall(packageRoot);

      expect(result.status).toBe(0);
      for (const helper of helpers) {
        expect(statSync(helper).mode & 0o777).toBe(0o755);
      }
    }
  );

  it.skipIf(process.platform === 'win32')('only repairs the current platform helper', () => {
    const packageRoot = createInstalledPackage('', false);
    const nativeRoot = join(packageRoot, 'node_modules/node-pty');
    mkdirSync(nativeRoot, { recursive: true });
    writeFileSync(
      join(nativeRoot, 'package.json'),
      JSON.stringify({ name: 'node-pty', version: '1.1.0' })
    );
    const other = join(nativeRoot, 'prebuilds/unrelated-platform/spawn-helper');
    mkdirSync(join(other, '..'), { recursive: true });
    writeFileSync(other, 'other helper');
    chmodSync(other, 0o644);
    expect(runPostinstall(packageRoot).status).toBe(0);
    expect(statSync(other).mode & 0o777).toBe(0o644);
  });

  it.skipIf(process.platform === 'win32')(
    'does not chmod a helper symlink outside the dependency',
    () => {
      const packageRoot = createInstalledPackage('', false);
      const nativeRoot = join(packageRoot, 'node_modules/node-pty');
      const prebuild = join(nativeRoot, 'prebuilds', `${process.platform}-${process.arch}`);
      mkdirSync(prebuild, { recursive: true });
      writeFileSync(
        join(nativeRoot, 'package.json'),
        JSON.stringify({ name: 'node-pty', version: '1.1.0' })
      );
      const outside = join(packageRoot, 'unrelated-file');
      writeFileSync(outside, 'unrelated');
      chmodSync(outside, 0o600);
      symlinkSync(outside, join(prebuild, 'spawn-helper'));
      expect(runPostinstall(packageRoot).status).toBe(0);
      expect(statSync(outside).mode & 0o777).toBe(0o600);
    }
  );

  it.skipIf(process.platform === 'win32')(
    'does not chmod through a platform directory symlink outside the dependency',
    () => {
      const packageRoot = createInstalledPackage('', false);
      const nativeRoot = join(packageRoot, 'node_modules/node-pty');
      mkdirSync(join(nativeRoot, 'prebuilds'), { recursive: true });
      writeFileSync(
        join(nativeRoot, 'package.json'),
        JSON.stringify({ name: 'node-pty', version: '1.1.0' })
      );
      const outside = join(packageRoot, 'unrelated-directory');
      mkdirSync(outside);
      const helper = join(outside, 'spawn-helper');
      writeFileSync(helper, 'unrelated helper');
      chmodSync(helper, 0o600);
      symlinkSync(
        outside,
        join(nativeRoot, 'prebuilds', `${process.platform}-${process.arch}`),
        'dir'
      );
      expect(runPostinstall(packageRoot).status).toBe(0);
      expect(statSync(helper).mode & 0o777).toBe(0o600);
    }
  );
});
