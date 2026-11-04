import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApplicationUpdateInstaller } from './application-update-installer';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots.length = 0;
});
async function fixture() {
  const prefix = await mkdtemp(join(tmpdir(), 'ff-update-test-'));
  roots.push(prefix);
  const root = join(prefix, 'lib/node_modules/factory-factory');
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'factory-factory', version: '0.5.3' })
  );
  const run = vi.fn(async (_command: string, args: string[]) => {
    if (args[0] === 'root') {
      return join(prefix, 'lib/node_modules');
    }
    if (args.includes('install')) {
      const stage = args[args.indexOf('--prefix') + 1]!;
      const candidate = join(stage, 'lib/node_modules/factory-factory');
      await mkdir(join(candidate, 'dist/src/backend'), { recursive: true });
      await mkdir(join(candidate, 'dist/src/cli'), { recursive: true });
      await mkdir(join(candidate, 'dist/client'), { recursive: true });
      await writeFile(
        join(candidate, 'package.json'),
        JSON.stringify({ name: 'factory-factory', version: '0.5.4' })
      );
      await writeFile(join(candidate, 'dist/src/backend/index.js'), '');
      await writeFile(join(candidate, 'dist/src/cli/index.js'), '');
      await writeFile(join(candidate, 'dist/client/index.html'), '');
    }
    return '';
  });
  return {
    root,
    prefix,
    run,
    installer: new ApplicationUpdateInstaller({
      packageRoot: root,
      env: {},
      run,
      platform: 'darwin',
    }),
  };
}
it('only allows updating the actual npm-global installation', async () => {
  const { installer, run } = await fixture();
  expect(await installer.isSupported()).toBe(true);
  run.mockResolvedValueOnce('/some/other/node_modules');
  expect(await installer.isSupported()).toBe(false);
});
it('stages a pinned release without changing the running installation', async () => {
  const { installer, root, run } = await fixture();
  const prepared = await installer.prepare('0.5.4', new AbortController().signal);
  expect(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version).toBe('0.5.3');
  expect(run.mock.calls.find((call) => call[1].includes('install'))?.[1]).toContain(
    'factory-factory@0.5.4'
  );
  await prepared.activate();
  expect(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version).toBe('0.5.4');
  await prepared.rollback();
  expect(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version).toBe('0.5.3');
  await prepared.dispose();
});
it('rejects versions and mismatched candidates before activation', async () => {
  const { installer, root } = await fixture();
  await expect(installer.prepare('latest;echo bad', new AbortController().signal)).rejects.toThrow(
    z.ZodError
  );
  await expect(installer.prepare('0.5.5', new AbortController().signal)).rejects.toThrow(
    /version|release/i
  );
  expect(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version).toBe('0.5.3');
});
it('keeps the running package when npm is unavailable', async () => {
  const { installer, run, root } = await fixture();
  run.mockImplementation((_cmd, args) => {
    if (args.includes('install')) {
      throw new Error('Registry unavailable');
    }
    return Promise.resolve(join(root, '..'));
  });
  await expect(installer.prepare('0.5.4', new AbortController().signal)).rejects.toThrow(
    'Registry unavailable'
  );
  expect(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version).toBe('0.5.3');
});
it('refuses unsupported platforms and a different package root', async () => {
  const { root, run } = await fixture();
  expect(
    await new ApplicationUpdateInstaller({
      packageRoot: root,
      env: {},
      run,
      platform: 'win32',
    }).isSupported()
  ).toBe(false);
});
it('rejects a second preparation while the installation lock is held', async () => {
  const { installer } = await fixture();
  const prepared = await installer.prepare('0.5.4', new AbortController().signal);
  await expect(installer.prepare('0.5.4', new AbortController().signal)).rejects.toThrow(
    /already|another|lock/i
  );
  await prepared.dispose();
  const retry = await installer.prepare('0.5.4', new AbortController().signal);
  await retry.dispose();
});

it.each(['freebsd', 'openbsd', 'aix', 'sunos'] as const)(
  'uses manual updates on unsupported platform %s',
  async (platform) => {
    const { root, run } = await fixture();
    expect(
      await new ApplicationUpdateInstaller({
        packageRoot: root,
        env: {},
        run,
        platform,
      }).isSupported()
    ).toBe(false);
    expect(run).not.toHaveBeenCalled();
  }
);
