import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

const { packageManager } = z
  .object({ packageManager: z.string() })
  .parse(JSON.parse(readFileSync('package.json', 'utf8')));
const binary = z.string().min(1).parse(process.env.npm_execpath);
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(manager = packageManager) {
  const directory = mkdtempSync(join(tmpdir(), 'ff-pnpm-version-'));
  directories.push(directory);
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({
      name: 'version-guard-fixture',
      packageManager: manager,
      scripts: { probe: 'node --version' },
    })
  );
  writeFileSync(join(directory, 'pnpm-workspace.yaml'), 'pmOnFail: ignore\n');
  if (existsSync('.pnpmfile.mjs')) {
    copyFileSync(resolve('.pnpmfile.mjs'), join(directory, '.pnpmfile.mjs'));
  }
  return directory;
}

function run(directory: string, args: string[]) {
  return spawnSync(binary, args, { cwd: directory, encoding: 'utf8', timeout: 15_000 });
}

describe('pinned package-manager guard', () => {
  it('permits the pinned manager to generate and frozen-install a single-document lockfile', () => {
    const directory = fixture();
    const generated = run(directory, [
      'install',
      '--lockfile-only',
      '--offline',
      '--ignore-scripts',
    ]);
    expect(generated.error).toBeUndefined();
    expect(generated.status, generated.stdout + generated.stderr).toBe(0);
    const lockfile = readFileSync(join(directory, 'pnpm-lock.yaml'), 'utf8');
    expect(lockfile).not.toContain('packageManagerDependencies');
    expect(lockfile.match(/^---\s*$/gm) ?? []).toHaveLength(0);
    const frozen = run(directory, [
      'install',
      '--frozen-lockfile',
      '--offline',
      '--ignore-scripts',
    ]);
    expect(frozen.status, frozen.stdout + frozen.stderr).toBe(0);
    expect(run(directory, ['run', 'probe']).status).toBe(0);
  });

  it('rejects an explicit user-agent override even when it claims the pinned version', () => {
    const directory = fixture();
    const result = run(directory, [
      `--config.user-agent=${packageManager.replace('@', '/')}`,
      'install',
      '--lockfile-only',
      '--offline',
      '--ignore-scripts',
    ]);
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('user-agent');
  });

  it.each([
    ['lock-only installation', ['install', '--lockfile-only', '--offline', '--ignore-scripts']],
    ['frozen installation', ['install', '--frozen-lockfile', '--offline', '--ignore-scripts']],
    ['script execution', ['run', 'probe']],
    ['command execution', ['exec', 'node', '--version']],
  ])('rejects the wrong manager before %s even without lifecycle scripts', (_name, args) => {
    const directory = fixture('pnpm@0.0.0');
    const result = run(directory, args);
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('Use pnpm@0.0.0');
  });
});
