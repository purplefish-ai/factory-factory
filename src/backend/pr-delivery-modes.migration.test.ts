import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { runMigrations } from './migrate';

it('defaults existing monitoring to main and preserves bindings on dedicated session deletion', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-pr-modes-'));
  const databasePath = join(dir, 'migration.db');
  const migrationsPath = join(dir, 'migrations');
  const source = join(process.cwd(), 'prisma/migrations');
  const migration = '20261009120000_pr_delivery_modes';
  let db: Database.Database | undefined;
  try {
    for (const name of readdirSync(source)) {
      if (name < migration) {
        cpSync(join(source, name), join(migrationsPath, name), { recursive: true });
      }
    }
    runMigrations({ databasePath, migrationsPath, log: () => undefined });
    db = new Database(databasePath);
    db.exec(`INSERT INTO Project(id,name,slug,repoPath,worktreeBasePath,updatedAt) VALUES('p','P','p','/tmp/p','/tmp/w',1000);
      INSERT INTO Workspace(id,projectId,name,updatedAt) VALUES('w','p','W',1000);
      INSERT INTO AgentSession(id,workspaceId,workflow,provider,updatedAt) VALUES('main','w','implement','CLAUDE',1000),('dedicated','w','pr-monitoring','CODEX',1000);
      INSERT INTO WorkspacePRMonitoring(workspaceId,enabled,recipientSessionId,bindingRevision,eventEpoch) VALUES('w',true,'main',4,3);
      INSERT INTO WorkspacePR(id,workspaceId,url) VALUES('pr','w','https://github.com/o/r/pull/1');`);
    db.close();
    db = undefined;
    const added = join(source, migration);
    if (readdirSync(source).includes(migration)) {
      cpSync(added, join(migrationsPath, migration), { recursive: true });
    }
    runMigrations({ databasePath, migrationsPath, log: () => undefined });
    db = new Database(databasePath);
    db.pragma('foreign_keys = ON');
    expect(
      db
        .prepare(
          'SELECT deliveryMode, recipientSessionId, bindingRevision, eventEpoch FROM WorkspacePRMonitoring'
        )
        .get()
    ).toEqual({
      deliveryMode: 'MAIN',
      recipientSessionId: 'main',
      bindingRevision: 4,
      eventEpoch: 3,
    });
    db.exec(
      "INSERT INTO WorkspacePRDedicatedSession(prId,sessionId) VALUES('pr','dedicated'); DELETE FROM AgentSession WHERE id='dedicated';"
    );
    expect(db.prepare('SELECT * FROM WorkspacePRDedicatedSession').get()).toEqual({
      prId: 'pr',
      sessionId: null,
    });
    db.exec("DELETE FROM WorkspacePR WHERE id='pr';");
    expect(db.prepare('SELECT * FROM WorkspacePRDedicatedSession').all()).toEqual([]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
