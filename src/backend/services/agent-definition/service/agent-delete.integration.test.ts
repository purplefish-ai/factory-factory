import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createLedgerFixture } from '@/backend/services/agent-definition/resources/testing/agent-ledger.test-support';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import type { AgentGitHubSourcePort } from '@/shared/agent-source';
import { Prisma } from '@prisma-gen/client';

let db: IntegrationDatabase;
let runtime: typeof import('../index');
let activationAccessor: typeof import('../resources/agent-activation.accessor').agentActivationAccessor;
let fixture: Awaited<ReturnType<typeof createLedgerFixture>>;
let projectId: string;

const port: AgentGitHubSourcePort = {
  getRepositoryIdentity: async () => ({ id: 'repo-1', name: 'org/repo' }),
  listIssueEvents: async () => ({ events: [], nextPage: null }),
  classifyError: () => 'unknown',
};

beforeAll(async () => {
  db = await createIntegrationDatabase();
  runtime = await vi.importActual<typeof import('../index')>('../index');
  ({ agentActivationAccessor: activationAccessor } = await vi.importActual<
    typeof import('../resources/agent-activation.accessor')
  >('../resources/agent-activation.accessor'));
}, 30_000);
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});
beforeEach(async () => {
  fixture = await createLedgerFixture(db, runtime);
  projectId = (
    await db.prisma.agentDefinition.findUniqueOrThrow({ where: { id: fixture.definitionId } })
  ).projectId;
});

const service = () => new runtime.AgentManagementService();
const signal = () => new AbortController().signal;
async function owner() {
  const definition = await db.prisma.agentDefinition.findUniqueOrThrow({
    where: { id: fixture.definitionId },
  });
  return {
    projectId,
    agentId: definition.id,
    expectedManagementRevision: definition.managementRevision,
  };
}
async function admitted(providerEventId: string) {
  const result = await fixture.admit(await fixture.event(providerEventId));
  if (!('runId' in result)) {
    throw new Error(`Expected an admitted run: ${JSON.stringify(result)}`);
  }
  return result.runId;
}
/** A run that has been claimed and settled, as settlement writes it. */
async function finished(providerEventId: string, workspaceId: string | null = null) {
  const runId = await admitted(providerEventId);
  expect(await runtime.claimNextRun()).toMatchObject({ status: 'CLAIMED', runId });
  const now = new Date();
  await db.prisma.agentRun.update({
    where: { id: runId },
    data: {
      status: 'COMPLETED',
      launchPhase: 'FINISHED',
      leaseExpiresAt: null,
      completedAt: now,
      workspaceId,
      result: { version: 1, summary: 'Done', pullRequests: [] },
    },
  });
  await db.prisma.agentInitialDelivery.update({
    where: { runId },
    data: { state: 'FINISHED', finishedAt: now },
  });
  return runId;
}
/** Everything the automation owns, and what it must leave behind. */
async function snapshot() {
  return {
    definition: await db.prisma.agentDefinition.findUnique({ where: { id: fixture.definitionId } }),
    triggers: await db.prisma.agentTrigger.findMany({ orderBy: { id: 'asc' } }),
    runs: await db.prisma.agentRun.findMany({ orderBy: { id: 'asc' } }),
    deliveries: await db.prisma.agentInitialDelivery.findMany({ orderBy: { id: 'asc' } }),
    evaluations: await db.prisma.agentEvaluation.findMany({ orderBy: { id: 'asc' } }),
    proposals: await db.prisma.agentProposal.findMany({ orderBy: { id: 'asc' } }),
  };
}

it('removes the definition, its triggers, run history, evaluations and accepted proposal, keeping workspaces and the source', async () => {
  await fixture.secondTrigger();
  // A trigger removed by an earlier edit is retained history and goes with the definition.
  await db.prisma.agentTrigger.update({
    where: { id: 'trigger-b' },
    data: { isConfigured: false, isEnabled: false, activationState: 'PAUSED' },
  });
  const author = await db.prisma.workspace.create({ data: { projectId, name: 'Author' } });
  const started = await db.prisma.workspace.create({ data: { projectId, name: 'Event run' } });
  await db.prisma.agentProposal.create({
    data: { workspaceId: author.id, specification: {}, agentDefinitionId: fixture.definitionId },
  });
  const done = await finished('event-1', started.id);
  await db.prisma.workspaceLaunchOrigin.create({
    data: { runId: done, workspaceId: started.id, projectId },
  });
  const queued = await admitted('event-2');
  await fixture.evaluation(await fixture.event('event-3'), {
    status: 'SKIPPED',
    reasonCode: 'FILTER_SKIPPED',
  });
  const before = await snapshot();
  expect(before.runs.map((run) => run.status).sort()).toEqual(['COMPLETED', 'QUEUED']);
  expect(before.evaluations).toHaveLength(3);

  expect(await service().delete(await owner())).toEqual({ deleted: true });

  expect(await snapshot()).toEqual({
    definition: null,
    triggers: [],
    runs: [],
    deliveries: [],
    evaluations: [],
    proposals: [],
  });
  expect(await db.prisma.agentRun.findUnique({ where: { id: queued } })).toBeNull();
  // Workspaces, their retained origin, the shared connection, its source state and events stay.
  expect(
    (await db.prisma.workspace.findMany({ orderBy: { name: 'asc' } })).map((row) => row.id)
  ).toEqual([author.id, started.id]);
  expect(
    await db.prisma.workspaceLaunchOrigin.findUnique({ where: { runId: done } })
  ).toMatchObject({ workspaceId: started.id, projectId });
  expect(
    await db.prisma.agentConnection.findUnique({ where: { id: fixture.connectionId } })
  ).not.toBeNull();
  expect(
    await db.prisma.agentSourceState.findUnique({ where: { connectionId: fixture.connectionId } })
  ).not.toBeNull();
  expect(await db.prisma.agentEvent.count()).toBe(3);
  await expect(service().get({ projectId, agentId: fixture.definitionId })).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
});

it.each(['PROVISIONING', 'READY', 'DISPATCHING', 'ACTIVE', 'NEEDS_ATTENTION'] as const)(
  'refuses while a claimed run is %s and changes nothing, not even pausing',
  async (launchPhase) => {
    await fixture.secondTrigger();
    const claimed = await admitted('event-1');
    const queued = await admitted('event-2');
    expect(await runtime.claimNextRun()).toMatchObject({ status: 'CLAIMED', runId: claimed });
    await db.prisma.agentRun.update({ where: { id: claimed }, data: { launchPhase } });
    await db.prisma.agentProposal.create({
      data: {
        workspaceId: (await db.prisma.workspace.create({ data: { projectId, name: 'Author' } })).id,
        specification: {},
        agentDefinitionId: fixture.definitionId,
      },
    });
    const before = await snapshot();

    await expect(service().delete(await owner())).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('1 run of this automation has started and not finished'),
    });

    expect(await snapshot()).toEqual(before);
    expect(before.definition).toMatchObject({ isEnabled: true, managementRevision: 1 });
    expect(before.triggers.map((row) => row.activationState)).toEqual(['ACTIVE', 'ACTIVE']);
    expect(before.runs.find((run) => run.id === queued)?.status).toBe('QUEUED');
  }
);

it('deletes once the claimed run finishes', async () => {
  const claimed = await admitted('event-1');
  expect(await runtime.claimNextRun()).toMatchObject({ status: 'CLAIMED', runId: claimed });
  await expect(service().delete(await owner())).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
  });
  await db.prisma.agentRun.update({
    where: { id: claimed },
    data: { status: 'CANCELLED', launchPhase: 'FINISHED', completedAt: new Date() },
  });
  expect(await service().delete(await owner())).toEqual({ deleted: true });
  expect(await db.prisma.agentRun.count()).toBe(0);
});

it('refuses a stale revision, foreign owners and archived projects without changing anything', async () => {
  const before = await snapshot();
  const current = await owner();
  await expect(
    service().delete({ ...current, expectedManagementRevision: 2 })
  ).rejects.toMatchObject({ code: 'CONFLICT' });
  await expect(service().delete({ ...current, projectId: 'foreign' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
  await expect(service().delete({ ...current, agentId: 'missing' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
  await db.prisma.project.update({ where: { id: projectId }, data: { isArchived: true } });
  await expect(service().delete(current)).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: 'Choose an active project.',
  });
  expect(await snapshot()).toEqual(before);
});

it('leaves a STARTING activation and in-flight source work with nothing to complete', async () => {
  await db.prisma.agentTrigger.update({
    where: { id: fixture.triggerId },
    data: {
      isEnabled: false,
      activationState: 'STARTING',
      activationGeneration: 2,
      activationBoundary: Prisma.DbNull,
      pendingActivation: {
        version: 1,
        provider: 'GITHUB',
        activationGeneration: 2,
        definitionRevision: 1,
        triggerRevision: 1,
        connectionId: fixture.connectionId,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        baselineId: null,
      },
    },
  });
  const [starting] = await activationAccessor.listStarting();
  expect(starting).toMatchObject({ triggerId: fixture.triggerId, generation: 2 });
  const eventId = await fixture.event('event-1');

  expect(await service().delete(await owner())).toEqual({ deleted: true });

  // Work that read the trigger before the delete finds nothing to write.
  if (!starting) {
    throw new Error('Expected a STARTING trigger');
  }
  await activationAccessor.recordBaseline(starting, 'baseline');
  await activationAccessor.failStarting(starting);
  expect(await activationAccessor.activate(starting, new Date())).toBe('GONE');
  expect(await fixture.evaluation(eventId)).toEqual({ status: 'REJECTED', reason: 'NOT_FOUND' });
  // The shared source stays and is simply no longer targeted by this automation.
  await new runtime.AgentSourcePollService(port, () => 10).pollCycle(signal());
  await new runtime.AgentActivationService(
    new runtime.AgentSourcePollService(port, () => 10)
  ).completePending(signal());
  expect(await db.prisma.agentTrigger.count()).toBe(0);
  expect(await db.prisma.agentEvaluation.count()).toBe(0);
  expect(
    await db.prisma.agentConnection.findUnique({ where: { id: fixture.connectionId } })
  ).not.toBeNull();
});

it('lets a workspace started by a deleted automation be deleted without its run', async () => {
  const workspace = await db.prisma.workspace.create({ data: { projectId, name: 'Event run' } });
  const runId = await finished('event-1', workspace.id);
  await db.prisma.workspaceLaunchOrigin.create({
    data: { runId, workspaceId: workspace.id, projectId },
  });
  await service().delete(await owner());
  await db.prisma.$transaction(async (tx) => {
    await runtime.eventRunResults.captureWorkspace(tx, {
      workspaceId: workspace.id,
      projectId,
      originRunId: runId,
      result: { version: 1, summary: 'Deleted later', pullRequests: [] },
    });
  });
});
