import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';

it('defaults existing and new settings to auto review without changing workspace permissions', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`
      CREATE TABLE UserSettings (id TEXT PRIMARY KEY, defaultWorkspacePermissions TEXT NOT NULL DEFAULT 'STRICT');
      INSERT INTO UserSettings (id, defaultWorkspacePermissions) VALUES ('existing', 'YOLO');
    `);
    db.exec(
      readFileSync('prisma/migrations/20261109150100_automation_permissions/migration.sql', 'utf8')
    );
    db.exec("INSERT INTO UserSettings (id) VALUES ('new')");
    expect(db.prepare('SELECT * FROM UserSettings ORDER BY id').all()).toEqual([
      { id: 'existing', defaultWorkspacePermissions: 'YOLO', automationPermissions: 'RELAXED' },
      { id: 'new', defaultWorkspacePermissions: 'STRICT', automationPermissions: 'RELAXED' },
    ]);
  } finally {
    db.close();
  }
});
