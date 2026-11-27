import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { snapshotSqliteDatabase } from './sqlite-snapshot';

/** Far longer than a single-step copy of the fixture takes; a stepped copy that restarts never finishes. */
const SNAPSHOT_BOUND_MS = 8000;

describe('snapshotSqliteDatabase', () => {
  let directory: string;
  let databasePath: string;
  let writer: Database.Database;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ff-snapshot-'));
    databasePath = join(directory, 'data.db');
    writer = new Database(databasePath);
    writer.pragma('journal_mode = WAL');
    writer.exec('CREATE TABLE note (id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
    // About 40 MB: thousands of pages, so a 100-page-per-step copy needs many steps.
    const insert = writer.prepare('INSERT INTO note (body) VALUES (?)');
    const filler = 'x'.repeat(4000);
    writer.transaction(() => {
      for (let index = 0; index < 10_000; index += 1) {
        insert.run(filler);
      }
    })();
  });

  afterEach(async () => {
    writer.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('finishes while another connection commits continuously', async () => {
    const insert = writer.prepare('INSERT INTO note (body) VALUES (?)');
    let writing = true;
    let commits = 0;
    // A commit in every event-loop turn, which is when a stepped copy would resume.
    const keepWriting = () => {
      if (!writing) {
        return;
      }
      insert.run('concurrent');
      commits += 1;
      setImmediate(keepWriting);
    };
    setImmediate(keepWriting);

    const destination = join(directory, 'snapshot.db');
    let timer: NodeJS.Timeout | undefined;
    const snapshotting = snapshotSqliteDatabase(databasePath, destination);
    try {
      const outcome = await Promise.race([
        snapshotting.then(() => 'finished'),
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve('timed out'), SNAPSHOT_BOUND_MS);
        }),
      ]);
      expect(outcome).toBe('finished');
    } finally {
      writing = false;
      clearTimeout(timer);
      // Let a copy that did not finish settle before the directory is removed.
      await snapshotting.catch(() => undefined);
    }

    expect(commits).toBeGreaterThan(0);
    const snapshot = new Database(destination, { readonly: true });
    try {
      expect(snapshot.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(snapshot.prepare('SELECT count(*) FROM note').pluck().get()).toBeGreaterThanOrEqual(
        10_000
      );
    } finally {
      snapshot.close();
    }
    if (process.platform !== 'win32') {
      expect((await stat(destination)).mode & 0o777).toBe(0o600);
    }
  }, 20_000);
});
