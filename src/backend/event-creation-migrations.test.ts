import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { runMigrations } from './migrate';

it('applies event creation migrations in the same order on fresh installs and upgrades while preserving existing projects', () => {
  const temp = mkdtempSync(join(tmpdir(), 'ff-event-migrations-'));
  const migrationsPath = join(process.cwd(), 'prisma/migrations');
  const baseline = join(temp, 'baseline');
  mkdirSync(baseline);
  for (const entry of readdirSync(migrationsPath, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name <= '20261101160000_agent_evaluation_retries') {
      cpSync(join(migrationsPath, entry.name), join(baseline, entry.name), { recursive: true });
    }
  }
  const freshPath = join(temp, 'fresh.db');
  const upgradePath = join(temp, 'upgrade.db');
  const log = () => undefined;
  let fresh: Database.Database | undefined;
  let upgrade: Database.Database | undefined;
  try {
    runMigrations({ databasePath: freshPath, migrationsPath, log });
    runMigrations({ databasePath: upgradePath, migrationsPath: baseline, log });
    upgrade = new Database(upgradePath);
    upgrade
      .prepare(
        'INSERT INTO Project (id, name, slug, repoPath, worktreeBasePath, updatedAt) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run('existing', 'Existing', 'existing', '/repo', '/worktrees', Date.now());
    expect(upgrade.prepare('PRAGMA table_info(AgentRun)').all()).not.toContainEqual(
      expect.objectContaining({ name: 'effectiveExecution' })
    );
    upgrade.close();
    runMigrations({ databasePath: upgradePath, migrationsPath, log });
    upgrade = new Database(upgradePath);
    fresh = new Database(freshPath);
    const order = 'SELECT migration_name FROM _prisma_migrations ORDER BY rowid';
    expect(upgrade.prepare(order).all()).toEqual(fresh.prepare(order).all());
    expect(upgrade.prepare('SELECT id, name FROM Project').all()).toEqual([
      { id: 'existing', name: 'Existing' },
    ]);
    for (const db of [fresh, upgrade]) {
      expect(db.prepare('PRAGMA table_info(AgentRun)').all()).toContainEqual(
        expect.objectContaining({ name: 'effectiveExecution' })
      );
      expect(db.prepare('SELECT count(*) AS count FROM WorkspaceLaunchOrigin').get()).toEqual({
        count: 0,
      });
      expect(db.prepare('SELECT count(*) AS count FROM AgentSessionLaunchOrigin').get()).toEqual({
        count: 0,
      });
    }
  } finally {
    fresh?.close();
    upgrade?.close();
    rmSync(temp, { recursive: true, force: true });
  }
});
