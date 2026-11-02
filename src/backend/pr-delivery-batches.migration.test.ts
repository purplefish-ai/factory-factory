import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { runMigrations } from './migrate';

const migration = '20261102161500_normalize_workspace_pr_delivery';
it('backfills complete batches once, preserving receipts and blocking inconsistent evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-pr-batches-'));
  const databasePath = join(dir, 'migration.db');
  const migrationsPath = join(dir, 'migrations');
  const source = join(process.cwd(), 'prisma/migrations');
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
        /* Silence fixture migration logs. */
      },
    });
    db = new Database(databasePath);
    db.exec(`INSERT INTO Project(id,name,slug,repoPath,worktreeBasePath,updatedAt) VALUES('p','P','p','/tmp/p','/tmp/w',1000);
      INSERT INTO Workspace(id,projectId,name,updatedAt) VALUES('w','p','W',1000),('other','p','Other',1000);`);
    const insert = db.prepare(`INSERT INTO WorkspacePREvent
      (id,workspaceId,kind,deduplicationKey,payload,state,attempts,deliveryId,deliverySessionId,deliveryProvider,deliveryProviderSessionId,deliveryBindingRevision,deliveryText,claimedAt,deliveredAt,createdAt)
      VALUES(?,'w','MONITORING_ENABLED',?,'{}',?,2,?,'session','CLAUDE','provider',7,?,1234,?,1000)`);
    insert.run('a', 'a', 'DISPATCHING', 'receipt-original', 'frozen', null);
    insert.run('b', 'b', 'DISPATCHING', 'receipt-original', 'frozen', null);
    insert.run('c', 'c', 'DELIVERED', 'receipt-settled', 'settled', 2345);
    insert.run('d', 'd', 'PENDING', 'inconsistent', 'first', null);
    insert.run('e', 'e', 'PENDING', 'inconsistent', 'different', null);
    insert.run('f', 'f', 'DISPATCHING', 'missing-provider', 'unknown', null);
    db.exec("UPDATE WorkspacePREvent SET deliveryProviderSessionId=NULL WHERE id='f'");
    insert.run('g', 'g', 'PENDING', 'oversized', 'x'.repeat(16_385), null);
    insert.run('h', 'h', 'PENDING', 'bad-provider', 'frozen', null);
    insert.run('i', 'i', 'PENDING', '', 'frozen', null);
    db.exec("UPDATE WorkspacePREvent SET deliveryProvider='unsupported' WHERE id='h'");
    insert.run('late', 'late', 'PENDING', 'cross-workspace', 'frozen', null);
    insert.run('early-b', 'early-b', 'PENDING', 'cross-workspace', 'frozen', null);
    insert.run('early-a', 'early-a', 'PENDING', 'cross-workspace', 'frozen', null);
    db.exec(
      "UPDATE WorkspacePREvent SET workspaceId='other' WHERE id IN ('late','early-b'); UPDATE WorkspacePREvent SET createdAt=2000 WHERE id='late'"
    );
    db.close();
    db = undefined;
    cpSync(join(source, migration), join(migrationsPath, migration), { recursive: true });
    runMigrations({
      databasePath,
      migrationsPath,
      log: () => {
        /* Silence fixture migration logs. */
      },
    });
    db = new Database(databasePath);
    expect(
      db
        .prepare(
          'SELECT id,state,sessionId,providerSessionId,bindingRevision,text,attempts,claimedAt FROM WorkspacePRDelivery WHERE id=?'
        )
        .get('receipt-original')
    ).toEqual({
      id: 'receipt-original',
      state: 'DISPATCHING',
      sessionId: 'session',
      providerSessionId: 'provider',
      bindingRevision: 7,
      text: 'frozen',
      attempts: 2,
      claimedAt: 1234,
    });
    expect(
      db.prepare('SELECT eventIds FROM WorkspacePRDelivery WHERE id=?').get('receipt-original')
    ).toEqual({ eventIds: '["a","b"]' });
    expect(
      db
        .prepare('SELECT state,deliveredAt FROM WorkspacePRDelivery WHERE id=?')
        .get('receipt-settled')
    ).toEqual({ state: 'DELIVERED', deliveredAt: 2345 });
    expect(
      db
        .prepare(
          "SELECT id,deliveryId,deliveryText,attempts FROM WorkspacePREvent WHERE id IN ('a','b') ORDER BY id"
        )
        .all()
    ).toEqual([
      { id: 'a', deliveryId: null, deliveryText: null, attempts: 0 },
      { id: 'b', deliveryId: null, deliveryText: null, attempts: 0 },
    ]);
    expect(
      db.prepare("SELECT id,state FROM WorkspacePRDelivery WHERE state='BLOCKED' ORDER BY id").all()
    ).toEqual([
      { id: '', state: 'BLOCKED' },
      { id: 'bad-provider', state: 'BLOCKED' },
      { id: 'cross-workspace', state: 'BLOCKED' },
      { id: 'inconsistent', state: 'BLOCKED' },
      { id: 'missing-provider', state: 'BLOCKED' },
      { id: 'oversized', state: 'BLOCKED' },
    ]);
    expect(
      db
        .prepare("SELECT deliveryText FROM WorkspacePREvent WHERE id IN ('d','e') ORDER BY id")
        .all()
    ).toEqual([{ deliveryText: 'first' }, { deliveryText: 'different' }]);
    expect(
      db
        .prepare('SELECT workspaceId,eventIds,state FROM WorkspacePRDelivery WHERE id=?')
        .get('cross-workspace')
    ).toEqual({ workspaceId: 'w', eventIds: '["early-a","early-b","late"]', state: 'BLOCKED' });
    expect(
      db
        .prepare(
          "SELECT id,deliveryId,state,deliveryText FROM WorkspacePREvent WHERE id IN ('late','early-a','early-b') ORDER BY id"
        )
        .all()
    ).toEqual([
      { id: 'early-a', deliveryId: 'cross-workspace', state: 'PENDING', deliveryText: 'frozen' },
      { id: 'early-b', deliveryId: 'cross-workspace', state: 'PENDING', deliveryText: 'frozen' },
      { id: 'late', deliveryId: 'cross-workspace', state: 'PENDING', deliveryText: 'frozen' },
    ]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
