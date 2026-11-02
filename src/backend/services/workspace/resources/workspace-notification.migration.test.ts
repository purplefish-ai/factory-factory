import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { runMigrations } from '@/backend/migrate';

it('migrates legacy delivered mail to acknowledged history and leaves pending bodies in the inbox', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-mail-migration-'));
  const databasePath = join(dir, 'migration.db');
  const migrationsPath = join(dir, 'migrations');
  const source = join(process.cwd(), 'prisma/migrations');
  const migration = '20261102194500_workspace_mail_inbox';
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
      INSERT INTO workspace_notifications(id,workspace_id,source_workspace_id,source_workspace_name,source_project_name,message,created_at,delivered_at)
      VALUES('delivered','w','sender','Sender','Project','old body',1000,2000),('pending','w','sender','Sender','Project','pending body',3000,NULL);`);
    db.close();
    db = undefined;
    cpSync(join(source, migration), join(migrationsPath, migration), { recursive: true });
    runMigrations({ databasePath, migrationsPath, log: () => undefined });
    db = new Database(databasePath);
    expect(
      db
        .prepare(
          'SELECT id,revision,kind,preview,acknowledged_at FROM workspace_notifications ORDER BY revision'
        )
        .all()
    ).toEqual([
      { id: 'delivered', revision: 1, kind: 'MESSAGE', preview: 'old body', acknowledged_at: 2000 },
      {
        id: 'pending',
        revision: 2,
        kind: 'MESSAGE',
        preview: 'pending body',
        acknowledged_at: null,
      },
    ]);
    expect(
      db
        .prepare(
          'SELECT revision,notified_revision,wake_acknowledged_revision,claim_id FROM workspace_mail_state'
        )
        .get()
    ).toEqual({ revision: 2, notified_revision: 0, wake_acknowledged_revision: 0, claim_id: null });
    expect(
      db.prepare("SELECT message FROM workspace_notifications WHERE id='pending'").get()
    ).toEqual({ message: 'pending body' });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.pragma('foreign_keys = ON');
    db.exec("DELETE FROM Workspace WHERE id='w'");
    expect(db.prepare('SELECT * FROM workspace_mail_state').all()).toEqual([]);
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
