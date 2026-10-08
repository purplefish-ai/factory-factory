import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { runMigrations } from './migrate';

it('preserves legacy monitoring without inventing a recipient and fences active fixers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-pr-events-'));
  const databasePath = join(dir, 'migration.db');
  const migrationsPath = join(dir, 'migrations');
  const source = join(process.cwd(), 'prisma/migrations');
  const migration = '20261008130000_pr_event_ledger';
  let db: Database.Database | undefined;
  try {
    for (const name of readdirSync(source)) {
      if (name < migration) {
        cpSync(join(source, name), join(migrationsPath, name), { recursive: true });
      }
    }
    runMigrations({
      databasePath,
      migrationsPath,
      log: () => {
        /* Silence migration logs in fixtures. */
      },
    });
    db = new Database(databasePath);
    db.exec(`INSERT INTO Project(id,name,slug,repoPath,worktreeBasePath,updatedAt) VALUES('project','Project','project','/tmp/repo','/tmp/worktrees',1000);
      INSERT INTO Workspace(id,projectId,name,updatedAt) VALUES('w','project','W',1000);
      INSERT INTO WorkspaceRatchet(workspaceId,enabled,activeSessionId,lastCheckedAt) VALUES('w',true,'legacy-fixer',1000);`);
    db.close();
    db = undefined;
    cpSync(join(source, migration), join(migrationsPath, migration), { recursive: true });
    runMigrations({
      databasePath,
      migrationsPath,
      log: () => {
        /* Silence migration logs in fixtures. */
      },
    });
    db = new Database(databasePath);
    expect(
      db
        .prepare(
          'SELECT enabled,recipientSessionId,eventEpoch,deliveryPauseReason,lastCheckedAt FROM WorkspacePRMonitoring'
        )
        .get()
    ).toEqual({
      enabled: 1,
      recipientSessionId: null,
      eventEpoch: 1,
      deliveryPauseReason: 'LEGACY_FIXER',
      lastCheckedAt: 1000,
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
it('cuts over without deleting main or legacy session records and preserves auto-iteration permissions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-pr-cutover-'));
  const databasePath = join(dir, 'migration.db');
  const migrationsPath = join(dir, 'migrations');
  const source = join(process.cwd(), 'prisma/migrations');
  const migration = '20261008140000_pr_monitoring_cutover';
  let db: Database.Database | undefined;
  try {
    for (const name of readdirSync(source)) {
      if (name < migration) {
        cpSync(join(source, name), join(migrationsPath, name), { recursive: true });
      }
    }
    runMigrations({
      databasePath,
      migrationsPath,
      log: () => {
        /* Silence migration logs in fixtures. */
      },
    });
    db = new Database(databasePath);
    db.exec(`INSERT INTO Project(id,name,slug,repoPath,worktreeBasePath,updatedAt) VALUES('project','Project','project','/tmp/repo','/tmp/worktrees',1000);
      INSERT INTO Workspace(id,projectId,name,updatedAt) VALUES('w','project','W',1000);
      INSERT INTO WorkspacePRMonitoring(workspaceId,enabled) VALUES('w',true);
      INSERT INTO AgentSession(id,workspaceId,workflow,model,provider,updatedAt) VALUES('main','w','implement','sonnet','CLAUDE',1000),('fixer','w','ratchet','sonnet','CLAUDE',1000);
      INSERT INTO UserSettings(id,userId,ratchetPermissions,updatedAt) VALUES('settings','user','RELAXED',1000);`);
    db.close();
    db = undefined;
    cpSync(join(source, migration), join(migrationsPath, migration), { recursive: true });
    runMigrations({
      databasePath,
      migrationsPath,
      log: () => {
        /* Silence migration logs in fixtures. */
      },
    });
    db = new Database(databasePath);
    expect(db.prepare('SELECT id FROM AgentSession ORDER BY id').all()).toEqual([
      { id: 'fixer' },
      { id: 'main' },
    ]);
    expect(db.prepare('SELECT autoIterationPermissions FROM UserSettings').get()).toEqual({
      autoIterationPermissions: 'RELAXED',
    });
    expect(
      db.prepare('SELECT recipientSessionId,deliveryPauseReason FROM WorkspacePRMonitoring').get()
    ).toEqual({ recipientSessionId: null, deliveryPauseReason: 'LEGACY_FIXER' });
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('WorkspaceRatchet','WorkspacePRRatchet')"
        )
        .all()
    ).toEqual([]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
