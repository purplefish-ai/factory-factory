import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { runMigrations } from '@/backend/migrate';

it('adds context lifecycle metadata without expiring or rewriting existing run data', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'ff-run-context-migration-'));
  const migrationsPath = join(tempDir, 'migrations');
  const databasePath = join(tempDir, 'upgrade.db');
  const migration = '20261102160001_agent_run_context_lifecycle';
  const source = join(process.cwd(), 'prisma/migrations');
  let database: Database.Database | undefined;
  try {
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name < migration) {
        cpSync(join(source, entry.name), join(migrationsPath, entry.name), { recursive: true });
      }
    }
    const options = { databasePath, migrationsPath, log: () => undefined };
    runMigrations(options);
    database = new Database(databasePath);
    database.exec(`
      INSERT INTO Project (id,name,slug,repoPath,worktreeBasePath,updatedAt) VALUES ('p','Project','project','/repo','/worktrees',CURRENT_TIMESTAMP);
      INSERT INTO AgentDefinition (id,projectId,name,instructions,updatedAt) VALUES ('d','p','Legacy','Task',CURRENT_TIMESTAMP);
      INSERT INTO AgentRun (id,agentDefinitionId,idempotencyKey,status,definitionSnapshot,input,errorMessage) VALUES
        ('r','d','old','COMPLETED','{"instructions":"Keep frozen instructions"}','{"version":1,"context":[]}','Keep diagnostics');
    `);
    const before = database.prepare('SELECT * FROM AgentRun').get();
    cpSync(join(source, migration), join(migrationsPath, migration), { recursive: true });
    runMigrations(options);
    runMigrations(options);
    expect(database.prepare('SELECT * FROM AgentRun').get()).toEqual({
      ...before!,
      contextExpiredAt: null,
    });
    expect(database.pragma('foreign_key_check')).toEqual([]);
  } finally {
    database?.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
