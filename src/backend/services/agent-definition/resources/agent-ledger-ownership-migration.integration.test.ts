import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { runMigrations } from '@/backend/migrate';

it('upgrades evaluated history without moving its original source ownership', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'ff-ledger-ownership-upgrade-'));
  const migrationsPath = join(tempDir, 'migrations');
  const databasePath = join(tempDir, 'upgrade.db');
  const source = join(process.cwd(), 'prisma/migrations');
  const currentMigration = '20261101150000_agent_evaluation_stable_trigger';
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
    database.pragma('foreign_keys = ON');
    database.exec(`
      INSERT INTO Project (id, name, slug, repoPath, worktreeBasePath, updatedAt)
        VALUES ('project', 'Project', 'project', '/repo', '/worktrees', CURRENT_TIMESTAMP);
      INSERT INTO AgentDefinition (id, projectId, name, instructions, updatedAt)
        VALUES ('definition', 'project', 'Saved agent', 'Original instructions', CURRENT_TIMESTAMP);
      INSERT INTO AgentConnection (id, provider, externalId, name, updatedAt)
        VALUES ('old-source', 'GITHUB', 'gh:repo-1', 'Original', CURRENT_TIMESTAMP),
               ('new-source', 'GITHUB', 'gh:repo-2', 'New', CURRENT_TIMESTAMP);
      INSERT INTO AgentTrigger (id, agentDefinitionId, type, connectionId, description, config, updatedAt)
        VALUES ('trigger', 'definition', 'GITHUB_ISSUE', 'old-source', 'Agent label', '{"version":1,"repositoryIds":["repo-1"],"actions":["labeled"]}', CURRENT_TIMESTAMP);
      INSERT INTO AgentEvent (id, connectionId, providerEventId, payload, occurredAt, observedAt, payloadExpiresAt, identityExpiresAt)
        VALUES ('event', 'old-source', 'provider-event', '{"original":"payload"}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      INSERT INTO AgentRun (id, agentDefinitionId, triggerId, eventId, idempotencyKey, status, definitionSnapshot, triggerSnapshot, input)
        VALUES ('run', 'definition', 'trigger', 'event', 'event-key', 'RUNNING', '{"instructions":"Frozen task"}', '{"connectionId":"old-source"}', '{"version":1,"context":[]}');
      INSERT INTO AgentEvaluation (id, eventId, connectionId, agentDefinitionId, triggerId, definitionRevision, triggerRevision, activationGeneration, status, reasonCode, explanation, configurationSnapshot, runId, expiresAt, updatedAt)
        VALUES ('evaluation', 'event', 'old-source', 'definition', 'trigger', 1, 1, 1, 'MATCHED', 'MATCHED', 'Original decision', '{"trigger":{"connectionId":"old-source"}}', 'run', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    `);
    const historyBefore = database.prepare('SELECT * FROM AgentEvaluation').all();
    const runBefore = database.prepare('SELECT * FROM AgentRun').all();
    cpSync(join(source, currentMigration), join(migrationsPath, currentMigration), {
      recursive: true,
    });
    runMigrations(options);
    runMigrations(options);
    database.exec(
      `UPDATE AgentTrigger SET connectionId = 'new-source', triggerRevision = 2 WHERE id = 'trigger'`
    );
    expect(database.prepare('SELECT * FROM AgentEvaluation').all()).toEqual(historyBefore);
    expect(database.prepare('SELECT * FROM AgentRun').all()).toEqual(runBefore);
    expect(database.prepare('SELECT connectionId FROM AgentTrigger').get()).toEqual({
      connectionId: 'new-source',
    });
    expect(database.pragma('foreign_key_check')).toEqual([]);
  } finally {
    database?.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
