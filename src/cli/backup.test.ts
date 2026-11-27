import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBackup, describeMismatchedSources, registerBackupCommand } from './backup';
import { readBackup } from './backup-manifest';

const FIXED_NOW = new Date('2026-11-27T10:15:00.123Z');
const IS_POSIX = process.platform !== 'win32';

async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

describe('ff backup', () => {
  let root: string;
  let baseDir: string;
  let databasePath: string;
  let writer: Database.Database;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ff-backup-'));
    baseDir = join(root, 'base');
    await mkdir(baseDir);
    databasePath = join(baseDir, 'data.db');
    // The "running backend": a second connection that stays open in WAL mode.
    writer = new Database(databasePath);
    writer.pragma('journal_mode = WAL');
    writer.exec('CREATE TABLE note (id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
    writer.prepare('INSERT INTO note (body) VALUES (?)').run('before');
  });

  afterEach(async () => {
    writer.close();
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('snapshots a database a running backend has open and is writing to', async () => {
    // Committed rows sit in the -wal file; an open write transaction is in flight.
    writer.prepare('INSERT INTO note (body) VALUES (?)').run('committed in wal');
    writer.exec('BEGIN IMMEDIATE');
    writer.prepare('INSERT INTO note (body) VALUES (?)').run('uncommitted');

    const { directory } = await createBackup({
      databasePath,
      baseDir,
      applicationVersion: '1.2.3',
      destination: join(root, 'out'),
    });

    writer.exec('COMMIT');
    writer.prepare('INSERT INTO note (body) VALUES (?)').run('after');

    // Sidecar files are never copied by hand; the snapshot is a single file.
    expect((await readdir(directory)).sort()).toEqual(['database.db', 'manifest.json']);
    const backup = await readBackup(directory);
    const snapshot = new Database(backup.databasePath, { readonly: true });
    try {
      expect(snapshot.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(snapshot.prepare('SELECT body FROM note ORDER BY id').pluck().all()).toEqual([
        'before',
        'committed in wal',
      ]);
    } finally {
      snapshot.close();
    }
    expect(backup.manifest).toMatchObject({
      formatVersion: 1,
      applicationVersion: '1.2.3',
      sourceDatabasePath: databasePath,
      sourceDataDirectory: baseDir,
      contents: { database: true, encryptionKey: false, codexAccounts: false },
    });
    // The writer is still usable afterwards.
    expect(writer.prepare('SELECT count(*) FROM note').pluck().get()).toBe(4);
  });

  it('copies the encryption key and Codex accounts with their permissions', async () => {
    await writeFile(join(baseDir, 'encryption.key'), Buffer.alloc(32, 7), { mode: 0o600 });
    const accountDir = join(baseDir, 'codex-accounts', 'acct_1');
    await mkdir(accountDir, { recursive: true, mode: 0o700 });
    await chmod(join(baseDir, 'codex-accounts'), 0o700);
    await writeFile(join(accountDir, 'auth.json'), '{"token":"secret"}', { mode: 0o600 });
    await writeFile(join(accountDir, 'config.toml'), 'x = 1\n', { mode: 0o400 });
    if (IS_POSIX) {
      await symlink('/etc/hosts', join(accountDir, 'link'));
    }

    const result = await createBackup({
      databasePath,
      baseDir,
      applicationVersion: '1.2.3',
      destination: join(root, 'out'),
    });

    const backup = await readBackup(result.directory);
    expect(backup.manifest.contents).toEqual({
      database: true,
      encryptionKey: true,
      codexAccounts: true,
    });
    expect(await stat(backup.encryptionKeyPath ?? '')).toMatchObject({ size: 32 });
    const copiedAccount = join(backup.codexAccountsPath ?? '', 'acct_1');
    expect((await readdir(copiedAccount)).sort()).toEqual(['auth.json', 'config.toml']);
    if (IS_POSIX) {
      expect(result.skipped).toEqual([join(accountDir, 'link')]);
      expect(await modeOf(result.directory)).toBe(0o700);
      expect(await modeOf(backup.databasePath)).toBe(0o600);
      expect(await modeOf(backup.encryptionKeyPath ?? '')).toBe(0o600);
      expect(await modeOf(join(copiedAccount, 'auth.json'))).toBe(0o600);
      expect(await modeOf(join(copiedAccount, 'config.toml'))).toBe(0o400);
      expect(await modeOf(copiedAccount)).toBe(0o700);
      expect(await modeOf(backup.codexAccountsPath ?? '')).toBe(0o700);
      expect(await modeOf(join(result.directory, 'manifest.json'))).toBe(0o600);
    }
  });

  it('defaults to a new directory in db-backups beside the database', async () => {
    const { directory } = await createBackup({
      databasePath,
      baseDir,
      applicationVersion: '1.2.3',
      now: () => FIXED_NOW,
    });

    expect(directory).toBe(join(baseDir, 'db-backups', 'backup-20261127T101500123Z'));
    expect((await readBackup(directory)).manifest.createdAt).toBe('2026-11-27T10:15:00.123Z');
    if (IS_POSIX) {
      expect(await modeOf(join(baseDir, 'db-backups'))).toBe(0o700);
    }
  });

  it('makes an existing default db-backups directory owner-only', async () => {
    const backups = join(baseDir, 'db-backups');
    await mkdir(backups, { mode: 0o755 });
    await chmod(backups, 0o755);

    await createBackup({ databasePath, baseDir, applicationVersion: '1.2.3' });

    if (IS_POSIX) {
      expect(await modeOf(backups)).toBe(0o700);
    }
  });

  it('refuses a destination inside the Codex accounts it would copy', async () => {
    await mkdir(join(baseDir, 'codex-accounts'));

    await expect(
      createBackup({
        databasePath,
        baseDir,
        applicationVersion: '1.2.3',
        destination: join(baseDir, 'codex-accounts', 'backup'),
      })
    ).rejects.toThrow('inside the Codex accounts');
    expect(await readdir(join(baseDir, 'codex-accounts'))).toEqual([]);
  });

  it('refuses a destination that reaches the Codex accounts through a link or a dotted name', async () => {
    await mkdir(join(baseDir, 'codex-accounts'));
    if (IS_POSIX) {
      const link = join(root, 'accounts-link');
      await symlink(join(baseDir, 'codex-accounts'), link);
      await expect(
        createBackup({
          databasePath,
          baseDir,
          applicationVersion: '1.2.3',
          destination: join(link, 'backup'),
        })
      ).rejects.toThrow('inside the Codex accounts');
    }
    // `..backup` is a child of codex-accounts, not a way out of it.
    await expect(
      createBackup({
        databasePath,
        baseDir,
        applicationVersion: '1.2.3',
        destination: join(baseDir, 'codex-accounts', '..backup'),
      })
    ).rejects.toThrow('inside the Codex accounts');
    expect(await readdir(join(baseDir, 'codex-accounts'))).toEqual([]);
  });

  it('refuses to create the backup as an absent codex-accounts directory', async () => {
    await expect(
      createBackup({
        databasePath,
        baseDir,
        applicationVersion: '1.2.3',
        destination: join(baseDir, 'codex-accounts'),
      })
    ).rejects.toThrow('Codex accounts');
    expect(existsSync(join(baseDir, 'codex-accounts'))).toBe(false);
  });

  it('never replaces a directory another process creates at the final name', async () => {
    const destination = join(root, 'out');
    // Someone creates the (empty) final directory while the backup is being built.
    let watching = true;
    const intruder = () => {
      if (!watching) {
        return;
      }
      if (existsSync(`${destination}.partial`) && !existsSync(destination)) {
        mkdirSync(destination);
        return;
      }
      setImmediate(intruder);
    };
    setImmediate(intruder);

    try {
      await expect(
        createBackup({ databasePath, baseDir, applicationVersion: '1.2.3', destination })
      ).rejects.toThrow('already exists');
    } finally {
      watching = false;
    }

    // Theirs is left as it was: still there, still empty, not replaced by the backup.
    expect(await readdir(destination)).toEqual([]);
    expect(existsSync(`${destination}.partial`)).toBe(false);
  });

  it('builds the backup under a .partial name and renames it only when complete', async () => {
    const destination = join(root, 'out');
    // What the destination's parent holds at each event-loop turn while the backup runs.
    const observed: string[][] = [];
    let watching = true;
    const watch = () => {
      if (watching) {
        observed.push(readdirSync(root).sort());
        setImmediate(watch);
      }
    };
    setImmediate(watch);

    let result: Awaited<ReturnType<typeof createBackup>>;
    try {
      result = await createBackup({
        databasePath,
        baseDir,
        applicationVersion: '1.2.3',
        destination,
      });
    } finally {
      watching = false;
    }

    expect(observed).toContainEqual(['base', 'out.partial']);
    expect(result.directory).toBe(destination);
    expect((await readdir(root)).sort()).toEqual(['base', 'out']);
    await expect(
      createBackup({
        databasePath,
        baseDir,
        applicationVersion: '1.2.3',
        destination: join(root, 'chosen.partial'),
      })
    ).rejects.toThrow('.partial');
  });

  it('reports a backup an interrupted run left behind and never reads it as a backup', async () => {
    // Interrupted after the manifest was written but before the rename: it looks complete.
    const { directory } = await createBackup({
      databasePath,
      baseDir,
      applicationVersion: '1.2.3',
      destination: join(root, 'complete'),
    });
    await mkdir(join(baseDir, 'db-backups'));
    const leftover = join(baseDir, 'db-backups', 'backup-20261127T090000000Z.partial');
    await rename(directory, leftover);

    await expect(readBackup(leftover)).rejects.toThrow('unfinished backup');

    const result = await createBackup({
      databasePath,
      baseDir,
      applicationVersion: '1.2.3',
      now: () => FIXED_NOW,
    });
    expect(result.leftovers).toEqual([leftover]);
    expect((await readdir(join(baseDir, 'db-backups'))).sort()).toEqual([
      'backup-20261127T090000000Z.partial',
      'backup-20261127T101500123Z',
    ]);

    // A rerun to a chosen path that was interrupted says so instead of "already exists".
    await mkdir(join(root, 'again.partial'));
    await expect(
      createBackup({
        databasePath,
        baseDir,
        applicationVersion: '1.2.3',
        destination: join(root, 'again'),
      })
    ).rejects.toThrow('interrupted');
  });

  it('says what happened and what to run when the default name is taken', async () => {
    await mkdir(join(baseDir, 'db-backups', 'backup-20261127T101500123Z'), { recursive: true });

    const failure = createBackup({
      databasePath,
      baseDir,
      applicationVersion: '1.2.3',
      now: () => FIXED_NOW,
    });

    await expect(failure).rejects.toThrow('already exists');
    await expect(failure).rejects.toThrow('Run `ff backup` again');
    await expect(failure).rejects.not.toThrow('choose a path that does not exist');
  });

  it('does not prune earlier manual backups', async () => {
    for (let index = 0; index < 5; index += 1) {
      await createBackup({
        databasePath,
        baseDir,
        applicationVersion: '1.2.3',
        now: () => new Date(FIXED_NOW.getTime() + index * 1000),
      });
    }

    expect(await readdir(join(baseDir, 'db-backups'))).toHaveLength(5);
  });

  it('refuses an existing destination and a missing database, leaving nothing behind', async () => {
    const destination = join(root, 'out');
    await mkdir(destination);

    await expect(
      createBackup({ databasePath, baseDir, applicationVersion: '1.2.3', destination })
    ).rejects.toThrow('already exists');
    await expect(
      createBackup({
        databasePath: join(baseDir, 'missing.db'),
        baseDir,
        applicationVersion: '1.2.3',
        destination: join(root, 'other'),
      })
    ).rejects.toThrow('No database found');

    expect(await readdir(destination)).toEqual([]);
    expect((await readdir(root)).sort()).toEqual(['base', 'out']);
  });

  it('leaves no partial directory when the copy fails', async () => {
    // A key that is a directory is refused after the snapshot has been written.
    await mkdir(join(baseDir, 'encryption.key'));

    await expect(
      createBackup({
        databasePath,
        baseDir,
        applicationVersion: '1.2.3',
        destination: join(root, 'out'),
      })
    ).rejects.toThrow('not a regular file');

    expect(existsSync(join(root, 'out'))).toBe(false);
    expect((await readdir(root)).sort()).toEqual(['base']);
  });

  describe('readBackup', () => {
    it('refuses a directory that is not a backup, an unknown format and an incomplete backup', async () => {
      const { directory } = await createBackup({
        databasePath,
        baseDir,
        applicationVersion: '1.2.3',
        destination: join(root, 'out'),
      });
      const manifestPath = join(directory, 'manifest.json');
      const valid = JSON.stringify((await readBackup(directory)).manifest);

      await expect(readBackup(root)).rejects.toThrow('manifest.json is missing');

      await writeFile(manifestPath, valid.replace('"formatVersion":1', '"formatVersion":2'));
      await expect(readBackup(directory)).rejects.toThrow('format version 2');

      await writeFile(manifestPath, '{not json');
      await expect(readBackup(directory)).rejects.toThrow('not valid JSON');

      await writeFile(manifestPath, valid.replace('"encryptionKey":false', '"encryptionKey":true'));
      await expect(readBackup(directory)).rejects.toThrow('encryption.key is missing');

      await writeFile(
        manifestPath,
        valid.replace(JSON.stringify(databasePath), JSON.stringify('data.db'))
      );
      await expect(readBackup(directory)).rejects.toThrow('absolute path');

      if (IS_POSIX) {
        const elsewhere = join(root, 'elsewhere.json');
        await writeFile(elsewhere, valid);
        await rm(manifestPath);
        await symlink(elsewhere, manifestPath);
        await expect(readBackup(directory)).rejects.toThrow('not a regular file');
      }
    });
  });

  describe('command', () => {
    it('backs up the database and data directory the environment selects, and warns about credentials', async () => {
      vi.stubEnv('BASE_DIR', baseDir);
      vi.stubEnv('DATABASE_PATH', '');
      await writeFile(join(baseDir, 'encryption.key'), Buffer.alloc(32, 1), { mode: 0o600 });
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const program = new Command().exitOverride();
      registerBackupCommand(program, '9.9.9');

      await program.parseAsync(['backup', '--output', join(root, 'cli-out')], { from: 'user' });

      const backup = await readBackup(join(root, 'cli-out'));
      expect(backup.manifest.applicationVersion).toBe('9.9.9');
      expect(backup.manifest.contents.encryptionKey).toBe(true);
      const output = log.mock.calls.map((call) => String(call[0])).join('\n');
      expect(output).toContain('contains credentials');
      expect(output).toContain(join(root, 'cli-out'));
      expect(output).toContain(`data directory (encryption key, Codex accounts): ${baseDir}`);
      expect(output).toContain(databasePath);
      expect(backup.manifest.sourceDataDirectory).toBe(baseDir);
      expect(backup.manifest.sourceDatabasePath).toBe(databasePath);
    });

    it('warns, without refusing, when the database is outside the data directory', async () => {
      const otherDatabase = join(root, 'other-install', 'data.db');
      await mkdir(join(root, 'other-install'));
      writer.close();
      const other = new Database(otherDatabase);
      other.exec('CREATE TABLE t (a)');
      other.close();
      writer = new Database(databasePath);
      vi.stubEnv('BASE_DIR', baseDir);
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const program = new Command().exitOverride();
      registerBackupCommand(program, '9.9.9');

      await program.parseAsync(
        ['backup', '--database-path', otherDatabase, '--output', join(root, 'cli-out')],
        { from: 'user' }
      );

      const warning = String(warn.mock.calls[0]?.[0]);
      expect(warning).toContain(otherDatabase);
      expect(warning).toContain(baseDir);
      expect(warning).toContain('is not inside the data directory');
      const backup = await readBackup(join(root, 'cli-out'));
      expect(backup.manifest.sourceDatabasePath).toBe(otherDatabase);
      expect(backup.manifest.sourceDataDirectory).toBe(baseDir);
      expect(log).toHaveBeenCalled();
    });

    it('does not warn when the database is inside the data directory', async () => {
      expect(await describeMismatchedSources({ databasePath, baseDir })).toBeUndefined();
      // A directory whose name starts with two dots is still inside.
      expect(
        await describeMismatchedSources({
          databasePath: join(baseDir, '..data', 'data.db'),
          baseDir,
        })
      ).toBeUndefined();
    });

    it('falls back to the paths as given when a real path cannot be read', async () => {
      // A path through a file fails with ENOTDIR, not "not found".
      expect(
        await describeMismatchedSources({ databasePath: join(databasePath, 'nested.db'), baseDir })
      ).toBeUndefined();
    });

    it('reports a backup an interrupted run left in db-backups', async () => {
      vi.stubEnv('BASE_DIR', baseDir);
      vi.stubEnv('DATABASE_PATH', '');
      const leftover = join(baseDir, 'db-backups', 'backup-20261127T090000000Z.partial');
      await mkdir(leftover, { recursive: true });
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const program = new Command().exitOverride();
      registerBackupCommand(program, '9.9.9');

      await program.parseAsync(['backup'], { from: 'user' });

      const warnings = warn.mock.calls.map((call) => String(call[0])).join('\n');
      expect(warnings).toContain(leftover);
      expect(warnings).toContain('interrupted');
    });

    it('warns when a link inside the data directory leads to a database elsewhere', async () => {
      if (!IS_POSIX) {
        return;
      }
      const external = join(root, 'other-install');
      await mkdir(external);
      await writeFile(join(external, 'data.db'), '');
      const link = join(baseDir, 'linked.db');
      await symlink(join(external, 'data.db'), link);

      const warning = await describeMismatchedSources({ databasePath: link, baseDir });

      expect(warning).toContain('is not inside the data directory');
      expect(warning).toContain(`a link to ${await realpath(join(external, 'data.db'))}`);
    });

    it('reports a failure and sets a nonzero exit code', async () => {
      vi.stubEnv('BASE_DIR', baseDir);
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const previousExitCode = process.exitCode;
      const program = new Command().exitOverride();
      registerBackupCommand(program, '9.9.9');

      try {
        await program.parseAsync(
          ['backup', '--database-path', join(baseDir, 'missing.db'), '--output', join(root, 'x')],
          { from: 'user' }
        );
        expect(process.exitCode).toBe(1);
      } finally {
        process.exitCode = previousExitCode;
      }
      expect(String(error.mock.calls[0]?.[0])).toContain('No database found');
    });
  });
});
