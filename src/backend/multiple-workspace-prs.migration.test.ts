import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { runMigrations } from './migrate';

function seedLegacyPRs(db: Database.Database) {
  for (const [number, state] of [
    [null, 'NONE'],
    [1, 'OPEN'],
    [2, 'MERGED'],
    [3, 'CLOSED'],
  ] as const) {
    db.prepare(
      `INSERT INTO Workspace (id, projectId, name, updatedAt) VALUES (?, 'project', ?, 1000)`
    ).run(state, state);
    db.prepare(`INSERT INTO WorkspacePR (workspaceId, url, number, state, ciStatus, discoveryRetryCount, reviewLastCommentId)
        VALUES (?, ?, ?, ?, 'FAILURE', 4, 'comment-1')`).run(
      state,
      number ? `https://github.com/org/repo/pull/${number}` : null,
      number,
      state
    );
    db.prepare(`INSERT INTO WorkspaceRatchet (workspaceId, activeSessionId, dispatchSnapshotKey, dispatchOutcome, dispatchRetryCount)
        VALUES (?, ?, 'snapshot', 'RUNNING', 2)`).run(state, state === 'OPEN' ? 'fixer-1' : null);
  }
}

it('preserves known PRs, discovery, and active fixer ownership in the collection migration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-multiple-prs-'));
  const databasePath = join(dir, 'migration.db');
  const oldMigrations = join(dir, 'old-migrations');
  const migrationsPath = join(process.cwd(), 'prisma/migrations');
  const migrationName = '20261008120000_multiple_workspace_prs';
  let db: Database.Database | undefined;
  try {
    for (const name of readdirSync(migrationsPath)) {
      if (name !== migrationName) {
        cpSync(join(migrationsPath, name), join(oldMigrations, name), { recursive: true });
      }
    }
    runMigrations({ databasePath, migrationsPath: oldMigrations, log: () => undefined });
    db = new Database(databasePath);
    db.exec(`INSERT INTO Project (id, name, slug, repoPath, worktreeBasePath, updatedAt)
      VALUES ('project', 'Project', 'project', '/tmp/repo', '/tmp/worktrees', 1000)`);
    seedLegacyPRs(db);
    db.exec(`INSERT INTO AgentSession (id, workspaceId, workflow, provider, updatedAt)
      VALUES ('fixer-1', 'OPEN', 'ratchet', 'CODEX', 1000)`);
    db.close();
    db = undefined;
    runMigrations({ databasePath, migrationsPath, log: () => undefined });
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
    expect(db.prepare("SELECT workspacePrId FROM AgentSession WHERE id = 'fixer-1'").get()).toEqual(
      { workspacePrId: 'legacy-pr-OPEN' }
    );
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
