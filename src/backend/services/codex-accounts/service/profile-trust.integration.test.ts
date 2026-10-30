import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'smol-toml';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { withNativeRpc } from './native-rpc';
import { resolveAccountContext } from './profile';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

it('loads linked-worktree local config after inheriting native repository trust', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'ff-trust-contract-')));
  directories.push(base);
  const repo = join(base, 'repo');
  const worktree = join(base, 'worktree');
  const native = join(base, 'native');
  await mkdir(native);
  execFileSync('git', ['init', repo], { stdio: 'pipe' });
  execFileSync(
    'git',
    [
      '-C',
      repo,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--allow-empty',
      '-m',
      'Initial',
    ],
    { stdio: 'pipe' }
  );
  execFileSync('git', ['-C', repo, 'worktree', 'add', '--detach', worktree], { stdio: 'pipe' });
  await mkdir(join(worktree, '.codex'));
  await writeFile(join(worktree, '.codex', 'config.toml'), 'model = "ff-project-trust-probe"\n');
  const row = {
    id: 'managed',
    kind: 'MANAGED' as const,
    label: 'Managed',
    enabled: true,
    identityKey: null,
  };
  const config = {
    getBaseDir: () => base,
    getCodexHome: () => native,
    getCodexSessionsDir: () => join(native, 'sessions'),
    getChildProcessEnv: () => ({}),
  };
  const context = await resolveAccountContext(row, config);
  // Each read starts the real Codex app-server. The default budget leaves only
  // five seconds for startup, which parallel suite load can exceed. Two reads at
  // 20 seconds each still fit the test budget, so an RPC failure is reported.
  const readConfig = () =>
    withNativeRpc(
      context,
      async (rpc) => {
        return z
          .object({ config: z.object({ model: z.string().nullish() }) })
          .parse(await rpc.request('config/read', { includeLayers: true, cwd: worktree })).config;
      },
      { timeoutMs: 20_000 }
    );
  expect((await readConfig()).model).not.toBe('ff-project-trust-probe');
  await writeFile(
    join(native, 'config.toml'),
    stringify({ projects: { [repo]: { trust_level: 'trusted' } } })
  );
  await resolveAccountContext(row, config);
  expect((await readConfig()).model).toBe('ff-project-trust-probe');
}, 60_000);
