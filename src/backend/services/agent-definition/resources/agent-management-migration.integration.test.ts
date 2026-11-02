import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { runMigrations } from '@/backend/migrate';

it('leaves legacy membership unknown regardless of active-looking state or invalid proposal evidence', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'ff-agent-management-migration-'));
  const migrationsPath = join(tempDir, 'migrations');
  const databasePath = join(tempDir, 'upgrade.db');
  const migration = '20261102033000_agent_management_membership';
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
      INSERT INTO Workspace (id,projectId,name,updatedAt) VALUES ('w','p','Author',CURRENT_TIMESTAMP);
      INSERT INTO AgentDefinition (id,projectId,name,instructions,isEnabled,updatedAt) VALUES ('d','p','Legacy','Task',1,CURRENT_TIMESTAMP);
      INSERT INTO AgentTrigger (id,agentDefinitionId,type,description,config,isEnabled,activationState,updatedAt) VALUES
        ('paused','d','SCHEDULE','Old','{"version":1,"cadence":"DAILY"}',0,'PAUSED',CURRENT_TIMESTAMP),
        ('active','d','SCHEDULE','Old active','{"version":1,"cadence":"DAILY"}',1,'ACTIVE',CURRENT_TIMESTAMP);
      INSERT INTO AgentProposal (id,workspaceId,agentDefinitionId,specification,updatedAt) VALUES ('proposal','w','d','{"invalid":true}',CURRENT_TIMESTAMP);
    `);
    cpSync(join(source, migration), join(migrationsPath, migration), { recursive: true });
    runMigrations(options);
    runMigrations(options);
    expect(database.prepare('SELECT id,isConfigured FROM AgentTrigger ORDER BY id').all()).toEqual([
      { id: 'active', isConfigured: null },
      { id: 'paused', isConfigured: null },
    ]);
    expect(database.prepare('SELECT managementRevision FROM AgentDefinition').get()).toEqual({
      managementRevision: 1,
    });
    expect(database.pragma('foreign_key_check')).toEqual([]);
  } finally {
    database?.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
