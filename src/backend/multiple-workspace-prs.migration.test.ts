import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { runMigrations } from './migrate';

it('preserves known PRs, discovery, and active fixer ownership in the collection migration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-multiple-prs-'));
  const databasePath = join(dir, 'migration.db');
  const oldMigrations = join(dir, 'old-migrations');
  const migrationsPath = join(process.cwd(), 'prisma/migrations');
  const migrationName = '20261008120000_multiple_workspace_prs';
  let db: Database.Database | undefined;
  try {
    for (const name of readdirSync(migrationsPath)) {
      if (name < migrationName) {
        cpSync(join(migrationsPath, name), join(oldMigrations, name), { recursive: true });
      }
    }
    runMigrations({
      databasePath,
      migrationsPath: oldMigrations,
      log: () => {
        /* Silence fixture migration logs. */
      },
    });
    db = new Database(databasePath);
    db.exec(`INSERT INTO Project (id, name, slug, repoPath, worktreeBasePath, updatedAt)
      VALUES ('project', 'Project', 'project', '/tmp/repo', '/tmp/worktrees', 1000)`);
    seedHistoricalPRs(db);
    db.close();
    db = undefined;
    cpSync(join(migrationsPath, migrationName), join(oldMigrations, migrationName), {
      recursive: true,
    });
    runMigrations({
      databasePath,
      migrationsPath: oldMigrations,
      log: () => {
        /* Silence fixture migration logs. */
      },
    });
    db = new Database(databasePath);
    expect(db.prepare('PRAGMA table_info(WorkspacePR)').all()).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'id' })])
    );
    expect(
      db
        .prepare(
          'SELECT id, workspaceId, state, reviewLastCommentId FROM WorkspacePR ORDER BY workspaceId'
        )
        .all()
    ).toEqual([
      {
        id: 'legacy-pr-CLOSED',
        workspaceId: 'CLOSED',
        state: 'CLOSED',
        reviewLastCommentId: 'comment-1',
      },
      {
        id: 'legacy-pr-MERGED',
        workspaceId: 'MERGED',
        state: 'MERGED',
        reviewLastCommentId: 'comment-1',
      },
      {
        id: 'legacy-pr-OPEN',
        workspaceId: 'OPEN',
        state: 'OPEN',
        reviewLastCommentId: 'comment-1',
      },
    ]);
    expect(
      db
        .prepare('SELECT workspaceId, retryCount FROM WorkspacePRDiscovery ORDER BY workspaceId')
        .all()
    ).toEqual(
      ['CLOSED', 'MERGED', 'NONE', 'OPEN'].map((workspaceId) => ({ workspaceId, retryCount: 4 }))
    );
    expect(
      db
        .prepare(
          "SELECT activeSessionId, activePrId FROM WorkspaceRatchet WHERE workspaceId = 'OPEN'"
        )
        .get()
    ).toEqual({ activeSessionId: 'fixer-1', activePrId: 'legacy-pr-OPEN' });
    expect(
      db
        .prepare(
          "SELECT dispatchSnapshotKey, dispatchRetryCount FROM WorkspacePRRatchet WHERE prId = 'legacy-pr-OPEN'"
        )
        .get()
    ).toEqual({ dispatchSnapshotKey: 'snapshot', dispatchRetryCount: 2 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function seedHistoricalPRs(db: Database.Database) {
  for (const [state, number] of [
    ['NONE', null],
    ['OPEN', 1],
    ['MERGED', 2],
    ['CLOSED', 3],
  ] as const) {
    db.prepare(
      `INSERT INTO Workspace (id, projectId, name, updatedAt) VALUES (?, 'project', ?, 1000)`
    ).run(state, state);
    db.prepare(`INSERT INTO WorkspacePR (workspaceId, url, number, state, ciStatus, discoveryRetryCount, reviewLastCommentId)
        VALUES (?, ?, ?, ?, 'FAILURE', 4, 'comment-1')`).run(
      state,
      number === null ? null : `https://github.com/org/repo/pull/${number}`,
      number,
      state
    );
    db.prepare(`INSERT INTO WorkspaceRatchet (workspaceId, activeSessionId, dispatchSnapshotKey, dispatchOutcome, dispatchRetryCount)
        VALUES (?, ?, 'snapshot', 'RUNNING', 2)`).run(state, state === 'OPEN' ? 'fixer-1' : null);
  }
}
