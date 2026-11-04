import { mkdtemp, mkdir, readFile, rm, writeFile, access, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  getUpdateStatePath,
  persistApplicationUpdateState,
  recoverInterruptedApplicationUpdate,
} from './application-update-recovery';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});
const deadPid = 2_147_483_647;
async function fixture() {
  const prefix = await mkdtemp(join(tmpdir(), 'ff-update-recovery-'));
  roots.push(prefix);
  const packageRoot = join(prefix, 'node_modules/factory-factory');
  const databasePath = join(prefix, 'data.db');
  const stage = join(dirname(packageRoot), '.factory-factory-update-fixture');
  const recoveryPath = join(stage, 'previous');
  const databaseBackup = join(stage, 'database-backup');
  await mkdir(packageRoot, { recursive: true });
  await mkdir(stage);
  await writeFile(
    join(packageRoot, 'package.json'),
    JSON.stringify({ name: 'factory-factory', version: '0.5.4' })
  );
  await writeFile(databasePath, 'migrated database');
  const state = {
    packageRoot,
    databasePath,
    pid: deadPid,
    status: { phase: 'restarting', targetVersion: '0.5.4' },
    recoveryPath,
    databaseBackup,
  };
  const statePath = join(dirname(packageRoot), '.factory-factory-update-state.json');
  const writeState = async (overrides: Record<string, unknown> = {}) =>
    writeFile(statePath, JSON.stringify({ ...state, ...overrides }));
  const previousPackage = async () => {
    await mkdir(recoveryPath);
    await writeFile(
      join(recoveryPath, 'package.json'),
      JSON.stringify({ name: 'factory-factory', version: '0.5.3' })
    );
    await writeFile(databaseBackup, 'original database');
  };
  return {
    prefix,
    packageRoot,
    databasePath,
    stage,
    recoveryPath,
    databaseBackup,
    statePath,
    writeState,
    previousPackage,
  };
}

describe('application update recovery journal', () => {
  it('records exact installation, database, process ownership and recovery checkpoint', async () => {
    const { packageRoot, databasePath, recoveryPath, databaseBackup, statePath } = await fixture();
    expect(getUpdateStatePath(packageRoot)).toBe(statePath);
    await persistApplicationUpdateState({
      packageRoot,
      databasePath,
      recoveryPath,
      databaseBackup,
      status: { phase: 'restarting', targetVersion: '0.5.4' },
    });
    const saved = z
      .object({
        packageRoot: z.string(),
        databasePath: z.string(),
        pid: z.number(),
        recoveryPath: z.string(),
        databaseBackup: z.string(),
      })
      .parse(JSON.parse(await readFile(statePath, 'utf8')));
    expect(saved).toEqual({
      packageRoot,
      databasePath,
      pid: process.pid,
      recoveryPath,
      databaseBackup,
    });
  });

  it('restores the database before restarting the previous package after an interrupted activation', async () => {
    const f = await fixture();
    await f.previousPackage();
    await f.writeState();
    for (const suffix of ['-wal', '-shm', '-journal']) {
      await writeFile(`${f.databasePath}${suffix}`, 'stale');
    }
    await mkdir(join(dirname(f.packageRoot), '.factory-factory-update-lock'));
    expect(await recoverInterruptedApplicationUpdate(f.packageRoot, f.databasePath)).toBe(true);
    expect(await readFile(f.databasePath, 'utf8')).toBe('original database');
    expect(
      z
        .object({ version: z.string() })
        .parse(JSON.parse(await readFile(join(f.packageRoot, 'package.json'), 'utf8'))).version
    ).toBe('0.5.3');
    for (const suffix of ['-wal', '-shm', '-journal']) {
      await expect(access(`${f.databasePath}${suffix}`)).rejects.toThrow();
    }
    const saved = z
      .object({ status: z.object({ phase: z.string(), error: z.string() }) })
      .parse(JSON.parse(await readFile(f.statePath, 'utf8')));
    expect(saved.status.phase).toBe('failed');
    expect(saved.status.error).toMatch(/interrupted.*recover/i);
    await expect(
      access(join(dirname(f.packageRoot), '.factory-factory-update-lock'))
    ).rejects.toThrow();
  });

  it('leaves installation and database unchanged when the updater process still lives', async () => {
    const f = await fixture();
    await f.previousPackage();
    await f.writeState({ pid: process.pid });
    await expect(
      recoverInterruptedApplicationUpdate(f.packageRoot, f.databasePath)
    ).rejects.toThrow(/running|alive/i);
    expect(await readFile(f.databasePath, 'utf8')).toBe('migrated database');
    await expect(access(f.recoveryPath)).resolves.toBeUndefined();
  });

  it('refuses recovery while another supported server has a live process marker', async () => {
    const f = await fixture();
    await f.previousPackage();
    await f.writeState();
    // PID 1 always lives; probing it may return EPERM and must still count as alive.
    await mkdir(join(dirname(f.packageRoot), '.factory-factory-running-1'));
    await expect(
      recoverInterruptedApplicationUpdate(f.packageRoot, f.databasePath)
    ).rejects.toThrow(/running|alive/i);
    expect(await readFile(f.databasePath, 'utf8')).toBe('migrated database');
  });

  it.each(['packageRoot', 'databasePath', 'recoveryPath', 'databaseBackup'])(
    'rejects a mismatched or unsafe %s without modifying files',
    async (field) => {
      const f = await fixture();
      await f.previousPackage();
      await f.writeState({ [field]: join(f.prefix, 'unrelated') });
      await expect(
        recoverInterruptedApplicationUpdate(f.packageRoot, f.databasePath)
      ).rejects.toThrow(/path|installation|database|journal/i);
      expect(await readFile(f.databasePath, 'utf8')).toBe('migrated database');
      await expect(access(f.recoveryPath)).resolves.toBeUndefined();
    }
  );

  it('refuses a symlinked snapshot and retains the previous installation', async () => {
    const f = await fixture();
    await f.previousPackage();
    await rm(f.databaseBackup);
    await symlink(f.databasePath, f.databaseBackup);
    await f.writeState();
    await expect(
      recoverInterruptedApplicationUpdate(f.packageRoot, f.databasePath)
    ).rejects.toThrow(/symbolic|symlink|snapshot|backup/i);
    await expect(access(f.recoveryPath)).resolves.toBeUndefined();
    expect(await readFile(f.databasePath, 'utf8')).toBe('migrated database');
  });

  it('refuses rollback without the recorded database snapshot', async () => {
    const f = await fixture();
    await f.previousPackage();
    await rm(f.databaseBackup);
    await f.writeState();
    await expect(
      recoverInterruptedApplicationUpdate(f.packageRoot, f.databasePath)
    ).rejects.toThrow(/snapshot|backup/i);
    await expect(access(f.recoveryPath)).resolves.toBeUndefined();
  });

  it('cleans known abandoned preparation while leaving the live installation untouched', async () => {
    const f = await fixture();
    await f.writeState({
      status: { phase: 'preparing', targetVersion: '0.5.4' },
      databaseBackup: undefined,
    });
    await mkdir(join(f.stage, 'lib'), { recursive: true });
    await mkdir(join(dirname(f.packageRoot), '.factory-factory-update-lock'));
    await recoverInterruptedApplicationUpdate(f.packageRoot, f.databasePath);
    expect(await readFile(f.databasePath, 'utf8')).toBe('migrated database');
    await expect(access(f.stage)).rejects.toThrow();
    await expect(access(join(f.packageRoot, 'package.json'))).resolves.toBeUndefined();
  });

  it('does not restore an old snapshot again on a later normal launch', async () => {
    const f = await fixture();
    await f.previousPackage();
    await f.writeState();
    expect(await recoverInterruptedApplicationUpdate(f.packageRoot, f.databasePath)).toBe(true);
    await writeFile(f.databasePath, 'new application data');
    expect(await recoverInterruptedApplicationUpdate(f.packageRoot, f.databasePath)).toBe(false);
    expect(await readFile(f.databasePath, 'utf8')).toBe('new application data');
  });

  it('refuses an activated target when its previous package is unexpectedly missing', async () => {
    const f = await fixture();
    await f.previousPackage();
    await rm(f.recoveryPath, { recursive: true });
    await f.writeState();
    await expect(
      recoverInterruptedApplicationUpdate(f.packageRoot, f.databasePath)
    ).rejects.toThrow(/previous|prior|recover/i);
    expect(await readFile(f.databasePath, 'utf8')).toBe('migrated database');
    await expect(access(f.databaseBackup)).resolves.toBeUndefined();
  });

  it('reports malformed JSON as an unusable recovery journal before migrations', async () => {
    const f = await fixture();
    await writeFile(f.statePath, '{');
    await expect(
      recoverInterruptedApplicationUpdate(f.packageRoot, f.databasePath)
    ).rejects.toThrow(/journal/i);
    expect(await readFile(f.databasePath, 'utf8')).toBe('migrated database');
  });

  it('allows another database launch without an update journal despite a live server marker', async () => {
    const f = await fixture();
    await mkdir(join(dirname(f.packageRoot), '.factory-factory-running-1'));
    expect(
      await recoverInterruptedApplicationUpdate(f.packageRoot, join(f.prefix, 'other.db'))
    ).toBe(false);
  });

  it.each(['idle', 'failed'])(
    'allows another database launch with an inactive %s journal',
    async (phase) => {
      const f = await fixture();
      await f.writeState({ status: { phase }, recoveryPath: undefined, databaseBackup: undefined });
      await mkdir(join(dirname(f.packageRoot), '.factory-factory-running-1'));
      expect(
        await recoverInterruptedApplicationUpdate(f.packageRoot, join(f.prefix, 'other.db'))
      ).toBe(false);
    }
  );

  it('does nothing on a first launch with no journal', async () => {
    const f = await fixture();
    await recoverInterruptedApplicationUpdate(f.packageRoot, f.databasePath);
    expect(await readFile(f.databasePath, 'utf8')).toBe('migrated database');
  });
});
