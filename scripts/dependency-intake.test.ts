import { execFile } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { z } from 'zod';

const execute = promisify(execFile);
const binary = z.string().min(1).parse(process.env.npm_execpath);
const { packageManager } = z
  .object({ packageManager: z.string() })
  .parse(JSON.parse(readFileSync('package.json', 'utf8')));
const policy = z
  .object({
    minimumReleaseAge: z.number(),
    minimumReleaseAgeStrict: z.boolean().optional(),
    minimumReleaseAgeIgnoreMissingTime: z.boolean().optional(),
    trustPolicy: z.string().optional(),
  })
  .parse(parse(readFileSync('pnpm-workspace.yaml', 'utf8')));
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function fixture(
  options: { fresh?: boolean; missingTime?: boolean; downgrade?: boolean } = {}
) {
  const directory = mkdtempSync(join(tmpdir(), 'ff-intake-'));
  directories.push(directory);
  const server = createServer((_request, response) => {
    const version = (value: string, trusted = false) => ({
      name: 'intake-fixture',
      version: value,
      ...(trusted
        ? { _npmUser: { trustedPublisher: { id: 'github', oidcConfigId: 'release' } } }
        : {}),
      dist: {
        tarball: `${registry}intake-fixture/-/intake-fixture-${value}.tgz`,
        integrity: `sha512-${'A'.repeat(86)}==`,
        ...(trusted
          ? { attestations: { provenance: { predicateType: 'https://slsa.dev/provenance/v1' } } }
          : {}),
      },
    });
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        name: 'intake-fixture',
        'dist-tags': { latest: '1.1.0' },
        versions: { '1.0.0': version('1.0.0', options.downgrade), '1.1.0': version('1.1.0') },
        ...(options.missingTime
          ? {}
          : {
              time: {
                '1.0.0': '2020-01-01T00:00:00.000Z',
                '1.1.0': options.fresh
                  ? new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()
                  : '2020-02-01T00:00:00.000Z',
              },
            }),
      })
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected an HTTP fixture port');
  }
  const registry = `http://127.0.0.1:${address.port}/`;
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({
      name: 'intake-consumer',
      packageManager,
      dependencies: { 'intake-fixture': '1.1.0' },
    })
  );
  writeFileSync(join(directory, '.npmrc'), `registry=${registry}\n`);
  const configure = (extra: Record<string, unknown> = {}) =>
    writeFileSync(
      join(directory, 'pnpm-workspace.yaml'),
      stringify({ pmOnFail: 'ignore', ...policy, ...extra })
    );
  configure();
  copyFileSync('.pnpmfile.mjs', join(directory, '.pnpmfile.mjs'));
  const run = async (...extra: string[]) => {
    try {
      const result = await execute(
        binary,
        [
          'install',
          '--lockfile-only',
          '--ignore-scripts',
          '--store-dir',
          join(directory, 'store'),
          ...extra,
        ],
        { cwd: directory, timeout: 15_000, maxBuffer: 1024 * 1024 }
      );
      return { success: true, output: result.stdout + result.stderr };
    } catch (error) {
      const result = z.object({ stdout: z.string(), stderr: z.string() }).parse(error);
      return { success: false, output: result.stdout + result.stderr };
    }
  };
  return {
    configure,
    run,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('dependency intake against the pinned pnpm CLI', () => {
  it('permits mature packages without requiring provenance from legacy publishers', async () => {
    const registry = await fixture();
    try {
      const result = await registry.run();
      expect(result.success, result.output).toBe(true);
    } finally {
      await registry.close();
    }
  }, 60_000);

  it('rejects a two-day-old exact version until its matching reviewed exception', async () => {
    const registry = await fixture({ fresh: true });
    try {
      const rejected = await registry.run();
      expect(rejected.success, rejected.output).toBe(false);
      registry.configure({ minimumReleaseAgeExclude: ['intake-fixture@1.0.0'] });
      const unrelatedException = await registry.run();
      expect(unrelatedException.success, unrelatedException.output).toBe(false);
      registry.configure({ minimumReleaseAgeExclude: ['intake-fixture@1.1.0'] });
      const allowed = await registry.run();
      expect(allowed.success, allowed.output).toBe(true);
    } finally {
      await registry.close();
    }
  }, 60_000);

  it('rejects registry metadata without publication dates', async () => {
    const registry = await fixture({ missingTime: true });
    try {
      const result = await registry.run();
      expect(result.success, result.output).toBe(false);
      expect(result.output).toContain('ERR_PNPM_MISSING_TIME');
    } finally {
      await registry.close();
    }
  }, 60_000);

  it('rejects a too-young version frozen into a lockfile under weaker policy', async () => {
    const registry = await fixture({ fresh: true });
    try {
      registry.configure({ minimumReleaseAge: 0 });
      const unlocked = await registry.run();
      expect(unlocked.success, unlocked.output).toBe(true);
      registry.configure();
      const locked = await registry.run('--frozen-lockfile');
      expect(locked.success, locked.output).toBe(false);
      expect(locked.output).toContain('Lockfile failed supply-chain policy check');
    } finally {
      await registry.close();
    }
  }, 60_000);

  it('rejects a trust downgrade even when the version was locked under weaker policy', async () => {
    const registry = await fixture({ downgrade: true });
    try {
      registry.configure({ trustPolicy: 'off' });
      const unlocked = await registry.run();
      expect(unlocked.success, unlocked.output).toBe(true);
      registry.configure();
      const locked = await registry.run('--frozen-lockfile');
      expect(locked.success, locked.output).toBe(false);
      expect(locked.output).toContain('ERR_PNPM_TRUST_DOWNGRADE');
    } finally {
      await registry.close();
    }
  }, 60_000);
});
