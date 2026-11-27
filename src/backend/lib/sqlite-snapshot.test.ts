import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { snapshotSqliteDatabase } from './sqlite-snapshot';

/** Far longer than a single-step copy of the fixture takes; a stepped copy that restarts never finishes. */
const SNAPSHOT_BOUND_MS = 8000;

/**
 * Another process, like a running backend: commits in every event-loop turn
 * until SIGTERM, prints `writing` after its first commit and its commit count on exit.
 */
const WRITER_SCRIPT = `
const Database = require(process.argv[1]);
const db = new Database(process.argv[2]);
db.pragma('busy_timeout = 5000');
const insert = db.prepare('INSERT INTO note (body) VALUES (?)');
let commits = 0;
process.on('SIGTERM', () => {
  db.close();
  process.stdout.write('commits ' + commits + '\\n');
  process.exit(0);
});
const keepWriting = () => {
  insert.run('concurrent');
  commits += 1;
  if (commits === 1) process.stdout.write('writing\\n');
  setImmediate(keepWriting);
};
keepWriting();
`;

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

  it('finishes while another process commits continuously', async () => {
    const child = spawn(
      process.execPath,
      ['-e', WRITER_SCRIPT, createRequire(import.meta.url).resolve('better-sqlite3'), databasePath],
      { stdio: ['ignore', 'pipe', 'inherit'] }
    );
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
    });
    const exited = once(child, 'exit');
    const destination = join(directory, 'snapshot.db');
    let timer: NodeJS.Timeout | undefined;
    let snapshotting: Promise<void> | undefined;
    try {
      // The writer is committing before the snapshot starts; bounded so `finally` always runs.
      const deadline = Date.now() + SNAPSHOT_BOUND_MS;
      while (!output.includes('writing') && child.exitCode === null && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(output).toContain('writing');

      snapshotting = snapshotSqliteDatabase(databasePath, destination);
      const outcome = await Promise.race([
        snapshotting.then(() => 'finished'),
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve('timed out'), SNAPSHOT_BOUND_MS);
        }),
      ]);
      expect(outcome).toBe('finished');
    } finally {
      child.kill('SIGTERM');
      await exited;
      clearTimeout(timer);
      // Let a copy that did not finish settle before the directory is removed.
      await snapshotting?.catch(() => undefined);
    }

    expect(Number(/commits (\d+)/.exec(output)?.[1])).toBeGreaterThan(1);
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
