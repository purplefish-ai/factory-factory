import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { resolveAccountContext, resolveHistoryContext } from './profile';
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});
it('rejects managed history symlinks for both runtime and offline history contexts', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ff-profile-'));
  directories.push(base);
  const row = {
    id: 'managed',
    kind: 'MANAGED' as const,
    identityKey: null,
    enabled: true,
    label: 'Managed',
  };
  const config = {
    getBaseDir: () => base,
    getCodexHome: () => base,
    getCodexSessionsDir: () => base,
    getChildProcessEnv: () => ({}),
  };
  const home = join(base, 'codex-accounts', row.id);
  await mkdir(home, { recursive: true });
  const other = join(base, 'other-account');
  await mkdir(other);
  await symlink(other, join(home, 'sessions'), process.platform === 'win32' ? 'junction' : 'dir');
  await expect(resolveAccountContext(row, config)).rejects.toThrow('sessions');
  await expect(resolveHistoryContext(row, config)).rejects.toThrow('history');
});
