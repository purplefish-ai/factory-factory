import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { runMigrations } from '@/backend/migrate';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';

let db: IntegrationDatabase;
beforeAll(async () => {
  db = await createIntegrationDatabase();
}, 30_000);
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});

it('migrates durable source, event, evaluation and initial delivery ledgers', async () => {
  const tables = await db.prisma.$queryRaw<Array<{ name: string }>>`
    SELECT name FROM sqlite_master WHERE type = 'table'
  `;
  expect(tables.map((table) => table.name)).toEqual(
    expect.arrayContaining([
      'AgentSourceState',
      'AgentEvent',
      'AgentEvaluation',
      'AgentInitialDelivery',
    ])
  );
});

it('keeps existing authoring paused and initializes revision and launch fences', async () => {
  const project = await db.prisma.project.create({
    data: {
      name: 'Migration project',
      slug: crypto.randomUUID(),
      repoPath: '/repo',
      worktreeBasePath: '/worktrees',
    },
  });
  const definition = await db.prisma.agentDefinition.create({
    data: {
      projectId: project.id,
      name: 'Migration agent',
      instructions: 'Investigate',
    },
  });
  expect(definition).toMatchObject({ isEnabled: false, definitionRevision: 1 });
  const trigger = await db.prisma.agentTrigger.create({
    data: {
      agentDefinitionId: definition.id,
      type: 'SCHEDULE',
      description: 'Daily',
      config: { version: 1, cadence: 'DAILY' },
    },
  });
  expect(trigger).toMatchObject({
    isEnabled: false,
    triggerRevision: 1,
    activationGeneration: 0,
    activationState: 'PAUSED',
  });
});

it('upgrades existing saved definitions and run snapshots without changing their contents', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'ff-ledger-upgrade-'));
  const migrationsPath = join(tempDir, 'migrations');
  const databasePath = join(tempDir, 'upgrade.db');
  const source = join(process.cwd(), 'prisma/migrations');
  const currentMigration = '20261101130000_add_agent_event_ledger';
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
      INSERT INTO AgentDefinition (id, projectId, name, instructions, updatedAt)
        VALUES ('definition', 'project', 'Saved agent', 'Original instructions', CURRENT_TIMESTAMP);
      INSERT INTO AgentConnection (id, provider, externalId, name, updatedAt)
        VALUES ('connection', 'GITHUB', 'gh:repo', 'Repo', CURRENT_TIMESTAMP);
      INSERT INTO AgentTrigger (id, agentDefinitionId, type, connectionId, description, config, updatedAt)
        VALUES ('trigger', 'definition', 'GITHUB_ISSUE', 'connection', 'Agent label', '{"version":1,"repositoryIds":["repo"],"actions":["labeled"]}', CURRENT_TIMESTAMP);
      INSERT INTO AgentRun (id, agentDefinitionId, triggerId, idempotencyKey, status, definitionSnapshot, triggerSnapshot, input)
        VALUES ('run', 'definition', 'trigger', 'legacy-event', 'COMPLETED', '{"instructions":"Frozen task"}', '{"description":"Frozen trigger"}', '{"version":1,"context":[]}');
    `);
    const historyBefore = database
      .prepare('SELECT definitionSnapshot, triggerSnapshot, input, status FROM AgentRun')
      .all();
    cpSync(join(source, currentMigration), join(migrationsPath, currentMigration), {
      recursive: true,
    });
    runMigrations(options);
    runMigrations(options);
    expect(
      database
        .prepare('SELECT definitionSnapshot, triggerSnapshot, input, status FROM AgentRun')
        .all()
    ).toEqual(historyBefore);
    expect(
      database.prepare('SELECT definitionRevision, isEnabled FROM AgentDefinition').get()
    ).toEqual({ definitionRevision: 1, isEnabled: 0 });
    expect(
      database
        .prepare('SELECT triggerRevision, activationState, activationGeneration FROM AgentTrigger')
        .get()
    ).toEqual({ triggerRevision: 1, activationState: 'PAUSED', activationGeneration: 0 });
    expect(database.pragma('foreign_key_check')).toEqual([]);
  } finally {
    database?.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
