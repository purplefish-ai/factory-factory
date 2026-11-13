import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { selectSandboxesToClean } from './clean.mjs';
import { realSystem } from './process-group.mjs';
import { readSandboxRecord } from './record.mjs';
import { launch, launcherEnv, spawnSleeper, temporaryDirectories } from './test-support';

const temporary = temporaryDirectories();
afterAll(() => temporary.cleanup());

describe('--clean selection', () => {
  it('selects only stale sandboxes that name their own directory', () => {
    const root = join(temporary.create('ffsb-'), 'ff-sandbox');
    const record = (baseDir: string, pid: number) =>
      JSON.stringify({
        baseDir,
        frontendUrl: null,
        backendUrl: null,
        pid,
        pgid: 4242,
        projectId: null,
        repoPath: join(baseDir, 'repo'),
        scenario: 'echo',
      });
    const dirs = ['stale', 'running', 'other', 'none'].map((name) => join(root, name));
    for (const dir of dirs) {
      mkdirSync(dir, { recursive: true });
    }
    const [stale, running, other] = dirs as [string, string, string, string];
    writeFileSync(join(stale, 'sandbox.json'), record(stale, 100));
    writeFileSync(join(running, 'sandbox.json'), record(running, 200));
    writeFileSync(join(other, 'sandbox.json'), record(stale, 100));
    symlinkSync(stale, join(root, 'link'));
    const selected = selectSandboxesToClean(root, (pid: number) => pid === 200);
    expect(selected.map((entry: { dir: string }) => entry.dir)).toEqual([stale]);
    expect(readSandboxRecord(join(stale, 'sandbox.json'))?.pgid).toBe(4242);
    expect(selectSandboxesToClean(join(root, 'missing'), () => false)).toEqual([]);
  });
});

describe('--clean on real directories', () => {
  it('--clean ignores a directory without a sandbox.json naming itself', async () => {
    const tempDir = temporary.create('ffsb-');
    const root = join(tempDir, 'ff-sandbox');
    const sleeper = spawnSleeper();
    try {
      const pgid = sleeper.pid ?? 0;
      const noRecord = join(root, 'sb-none');
      const elsewhere = join(root, 'sb-elsewhere');
      const broken = join(root, 'sb-broken');
      for (const dir of [noRecord, elsewhere, broken]) {
        mkdirSync(dir, { recursive: true });
      }
      // A dead launcher, naming another directory and a live process group.
      const record = { frontendUrl: null, backendUrl: null, projectId: null, scenario: 'echo' };
      writeFileSync(
        join(elsewhere, 'sandbox.json'),
        JSON.stringify({ ...record, baseDir: noRecord, pid: 999_999, pgid, repoPath: '' })
      );
      writeFileSync(join(broken, 'sandbox.json'), '{');
      const clean = launch(['--clean'], launcherEnv(tempDir));
      expect(await clean.exited).toBe(0);
      expect([noRecord, elsewhere, broken].map((dir) => existsSync(dir))).toEqual([
        true,
        true,
        true,
      ]);
      expect(sleeper.exitCode).toBeNull();
    } finally {
      sleeper.kill('SIGKILL');
    }
  }, 30_000);

  it('removes a stale sandbox without signalling a group that is no longer its own', async () => {
    const tempDir = temporary.create('ffsb-');
    const dir = join(tempDir, 'ff-sandbox', 'sb-stale');
    mkdirSync(dir, { recursive: true });
    // An unrelated process group that happens to carry the recorded ID.
    const unrelated = spawnSleeper();
    try {
      writeFileSync(
        join(dir, 'sandbox.json'),
        JSON.stringify({
          baseDir: dir,
          frontendUrl: null,
          backendUrl: null,
          pid: 999_999,
          pgid: unrelated.pid,
          projectId: null,
          repoPath: join(dir, 'repo'),
          scenario: 'echo',
        })
      );
      const clean = launch(['--clean'], launcherEnv(tempDir));
      expect(await clean.exited).toBe(0);
      expect(existsSync(dir)).toBe(false);
      const live = new Set(realSystem.listProcesses().map((process) => process.pid));
      expect(live.has(unrelated.pid ?? 0)).toBe(true);
      expect(clean.output()).toContain('no longer belongs');
    } finally {
      unrelated.kill('SIGKILL');
    }
  }, 30_000);
});
