import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import {
  clearIntegrationDatabase,
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';

let db: IntegrationDatabase;
beforeAll(async () => {
  db = await createIntegrationDatabase();
}, 30_000);
afterEach(async () => {
  await db.prisma.agentDefinition.deleteMany();
  await db.prisma.agentConnection.deleteMany();
  await clearIntegrationDatabase(db.prisma);
});
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});

async function createAgent() {
  const project = await db.prisma.project.create({
    data: {
      name: 'Project',
      slug: crypto.randomUUID(),
      repoPath: '/repo',
      worktreeBasePath: '/worktrees',
    },
  });
  return db.prisma.agentDefinition.create({
    data: { projectId: project.id, name: 'Investigator', instructions: 'Investigate bugs' },
  });
}

async function createSlackTrigger(agentDefinitionId: string) {
  const connection = await db.prisma.agentConnection.create({
    data: { provider: 'SLACK', externalId: crypto.randomUUID(), name: 'Team' },
  });
  return db.prisma.agentTrigger.create({
    data: {
      agentDefinitionId,
      type: 'SLACK_MESSAGE',
      connectionId: connection.id,
      description: 'Investigate feedback',
      config: { version: 1, channelIds: ['C-feedback'] },
    },
  });
}

const snapshot = {
  name: 'Investigator',
  instructions: 'Investigate bugs',
  isEnabled: true,
  executionConfig: { version: 1 },
};
const input = { version: 1, context: [] };

it('allows multiple independent triggers on an agent with no mandatory schedule', async () => {
  const agent = await createAgent();
  expect(agent.isEnabled).toBe(false);
  const slack = await createSlackTrigger(agent.id);
  await db.prisma.agentTrigger.create({
    data: {
      agentDefinitionId: agent.id,
      type: 'SCHEDULE',
      description: 'Daily',
      config: { version: 1, cadence: 'DAILY' },
    },
  });
  const saved = await db.prisma.agentDefinition.findUniqueOrThrow({
    where: { id: agent.id },
    include: { triggers: true },
  });
  expect(saved.triggers).toHaveLength(2);
  expect(saved.triggers.find((trigger) => trigger.id === slack.id)?.description).toBe(
    'Investigate feedback'
  );
});

it('deduplicates runs per agent without blocking another agent on the same event', async () => {
  const agent = await createAgent();
  const other = await createAgent();
  const data = {
    agentDefinitionId: agent.id,
    idempotencyKey: 'slack:event-1',
    definitionSnapshot: snapshot,
    input,
  };
  await db.prisma.agentRun.create({ data });
  await expect(db.prisma.agentRun.create({ data })).rejects.toMatchObject({ code: 'P2002' });
  await db.prisma.agentRun.create({ data: { ...data, agentDefinitionId: other.id } });
  expect(await db.prisma.agentRun.count()).toBe(2);
});

it('rejects a run associated with another agent’s trigger', async () => {
  const agent = await createAgent();
  const other = await createAgent();
  const trigger = await createSlackTrigger(agent.id);
  await expect(
    db.prisma.agentRun.create({
      data: {
        agentDefinitionId: other.id,
        triggerId: trigger.id,
        idempotencyKey: 'event-1',
        definitionSnapshot: snapshot,
        input,
      },
    })
  ).rejects.toMatchObject({ code: 'P2003' });
});

it('keeps run snapshots after edits and prevents deleting a trigger with run history', async () => {
  const agent = await createAgent();
  const trigger = await createSlackTrigger(agent.id);
  const run = await db.prisma.agentRun.create({
    data: {
      agentDefinitionId: agent.id,
      triggerId: trigger.id,
      idempotencyKey: 'event-1',
      definitionSnapshot: snapshot,
      triggerSnapshot: { description: trigger.description },
      input,
    },
  });
  await db.prisma.agentDefinition.update({
    where: { id: agent.id },
    data: { instructions: 'New instructions' },
  });
  await db.prisma.agentTrigger.update({ where: { id: trigger.id }, data: { isEnabled: false } });
  await expect(db.prisma.agentTrigger.delete({ where: { id: trigger.id } })).rejects.toMatchObject({
    code: 'P2003',
  });
  const saved = await db.prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
  expect(saved.triggerId).toBe(trigger.id);
  expect(saved.agentDefinitionId).toBe(agent.id);
  expect(saved.definitionSnapshot).toMatchObject({ instructions: 'Investigate bugs' });
  expect(saved.triggerSnapshot).toMatchObject({ description: 'Investigate feedback' });
});

it('prevents deleting a connection that is still referenced by a trigger', async () => {
  const agent = await createAgent();
  const trigger = await createSlackTrigger(agent.id);
  await expect(
    db.prisma.agentConnection.delete({ where: { id: trigger.connectionId ?? '' } })
  ).rejects.toMatchObject({ code: 'P2003' });
});

it('retains history when a workspace is removed, and retains a workspace when an agent is removed', async () => {
  const agent = await createAgent();
  const workspace = await db.prisma.workspace.create({
    data: { projectId: agent.projectId, name: 'Investigation' },
  });
  const run = await db.prisma.agentRun.create({
    data: {
      agentDefinitionId: agent.id,
      workspaceId: workspace.id,
      idempotencyKey: 'event-1',
      definitionSnapshot: snapshot,
      input,
    },
  });
  await db.prisma.workspace.delete({ where: { id: workspace.id } });
  expect(await db.prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
    workspaceId: null,
  });
  const retained = await db.prisma.workspace.create({
    data: { projectId: agent.projectId, name: 'Retained investigation' },
  });
  await db.prisma.agentRun.update({ where: { id: run.id }, data: { workspaceId: retained.id } });
  await db.prisma.agentDefinition.delete({ where: { id: agent.id } });
  expect(await db.prisma.workspace.findUnique({ where: { id: retained.id } })).not.toBeNull();
  expect(await db.prisma.agentRun.count()).toBe(0);
});
