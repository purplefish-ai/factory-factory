import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';

it('adds recovery opt-in without changing existing delivery timestamps or pending intent', () => {
  const db = new Database(':memory:');
  try {
    db.exec(
      'CREATE TABLE workspace_notifications (id TEXT PRIMARY KEY, message TEXT NOT NULL, delivered_at DATETIME);'
    );
    db.exec(
      "INSERT INTO workspace_notifications VALUES ('pending', 'Keep this intent', NULL), ('sent', 'Already delivered', '2026-11-01');"
    );
    db.exec(
      readFileSync(
        'prisma/migrations/20261102210000_hold_imported_workspace_notification_intent/migration.sql',
        'utf8'
      )
    );
    expect(db.prepare('SELECT * FROM workspace_notifications ORDER BY id').all()).toEqual([
      { id: 'pending', message: 'Keep this intent', delivered_at: null, recovery_held: 0 },
      { id: 'sent', message: 'Already delivered', delivered_at: '2026-11-01', recovery_held: 0 },
    ]);
  } finally {
    db.close();
  }
});
