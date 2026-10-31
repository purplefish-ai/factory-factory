import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { runMigrations } from '@/backend/migrate';

it('upgrades an existing scheduled agent without rewriting its definition or history', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'ff-agent-upgrade-'));
  const migrationsPath = join(tempDir, 'migrations');
  const databasePath = join(tempDir, 'upgrade.db');
  const currentMigration = '20261031130000_add_agent_definitions';
  const source = join(process.cwd(), 'prisma/migrations');
  let database: Database.Database | undefined;
  try {
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name < currentMigration) {
        cpSync(join(source, entry.name), join(migrationsPath, entry.name), { recursive: true });
      }
    }
    const options = { databasePath, migrationsPath, log: () => undefined };
    runMigrations(options);
    database = new Database(databasePath);
    database.exec(`
      INSERT INTO Project (id, name, slug, repoPath, worktreeBasePath, updatedAt)
      VALUES ('project', 'Project', 'project', '/repo', '/worktrees', CURRENT_TIMESTAMP);
      INSERT INTO PeriodicTask (id, projectId, name, prompt, cadence, nextRunAt, updatedAt)
      VALUES ('scheduled', 'project', 'Daily investigator', 'Find bugs', 'DAILY', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      INSERT INTO PeriodicTaskExecution (id, periodicTaskId, status)
      VALUES ('execution', 'scheduled', 'COMPLETED');
    `);
    const definitionBefore = database.prepare('SELECT * FROM PeriodicTask').all();
    const historyBefore = database.prepare('SELECT * FROM PeriodicTaskExecution').all();
    cpSync(join(source, currentMigration), join(migrationsPath, currentMigration), {
      recursive: true,
    });
    runMigrations(options);
    runMigrations(options);
    expect(database.prepare('SELECT * FROM PeriodicTask').all()).toEqual(definitionBefore);
    expect(database.prepare('SELECT * FROM PeriodicTaskExecution').all()).toEqual(historyBefore);
    expect(database.prepare('SELECT COUNT(*) AS count FROM AgentDefinition').get()).toEqual({
      count: 0,
    });
    expect(database.pragma('foreign_key_check')).toEqual([]);
  } finally {
    database?.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
