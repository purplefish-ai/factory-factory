import { chmod, mkdtemp, mkdir, writeFile, readFile, rm, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  ApplicationUpdateInstaller,
  ApplicationUpdateActivationRecoveryError,
} from './application-update-installer';

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
it('refuses a symlinked package root', async () => {
  const { prefix, root, run } = await fixture();
  const linked = join(prefix, 'linked-factory-factory');
  await symlink(root, linked);
  const linkedInstaller = new ApplicationUpdateInstaller({
    packageRoot: linked,
    env: {},
    run,
    platform: 'darwin',
  });
  expect(await linkedInstaller.isSupported()).toBe(false);
});
// Root ignores directory permissions, so the read-only case needs an ordinary user.
it.skipIf(process.getuid?.() === 0)(
  'refuses an installation directory it cannot write',
  async () => {
    const { root, run } = await fixture();
    const parent = dirname(root);
    await chmod(parent, 0o555);
    try {
      const readOnly = new ApplicationUpdateInstaller({
        packageRoot: root,
        env: {},
        run,
        platform: 'darwin',
      });
      expect(await readOnly.isSupported()).toBe(false);
    } finally {
      await chmod(parent, 0o755);
    }
  }
);
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
it.each([
  ['missing client entrypoint', /ENOENT.*dist\/client\/index\.html/],
  ['failing native module probe', /Cannot find module better-sqlite3/],
] as const)(
  'rejects a candidate with a %s and keeps the running package',
  async (fault, expectedError) => {
    const { installer, root, run } = await fixture();
    const install = run.getMockImplementation()!;
    run.mockImplementation(async (command, args) => {
      if (fault === 'failing native module probe' && args[0] === '-e') {
        throw new Error('Cannot find module better-sqlite3');
      }
      const output = await install(command, args);
      if (fault === 'missing client entrypoint' && args.includes('install')) {
        const stage = args[args.indexOf('--prefix') + 1]!;
        await rm(join(stage, 'lib/node_modules/factory-factory/dist/client/index.html'));
      }
      return output;
    });
    await expect(installer.prepare('0.5.4', new AbortController().signal)).rejects.toThrow(
      expectedError
    );
    expect(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version).toBe('0.5.3');
  }
);
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

it('retains the previous package when activation and its compensation both fail', async () => {
  const { root, run } = await fixture();
  let moves = 0;
  const installer = new ApplicationUpdateInstaller({
    packageRoot: root,
    env: {},
    run,
    platform: 'darwin',
    move: (...args) => {
      moves += 1;
      if (moves === 2 || moves === 3) {
        return Promise.reject(new Error('rename permission denied'));
      }
      return rename(...args);
    },
  });
  const prepared = await installer.prepare('0.5.4', new AbortController().signal);
  await expect(prepared.activate()).rejects.toThrow(ApplicationUpdateActivationRecoveryError);
  expect(
    JSON.parse(await readFile(join(prepared.recoveryPath, 'package.json'), 'utf8')).version
  ).toBe('0.5.3');
  await expect(readFile(join(root, 'package.json'), 'utf8')).rejects.toMatchObject({
    code: 'ENOENT',
  });
});
