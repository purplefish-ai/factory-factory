import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { AgentSourcePollService } from '@/backend/services/agent-definition';
import {
  createLedgerFixture,
  executionConfig,
} from '@/backend/services/agent-definition/resources/testing/agent-ledger.test-support';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import type { AgentGitHubSourcePort, AgentIssueEventPage } from '@/shared/agent-source';

let db: IntegrationDatabase;
let runtime: typeof import('../index');
let accessor: typeof import('../resources/agent-source.accessor').agentSourceAccessor;
let fixture: Awaited<ReturnType<typeof createLedgerFixture>>;
let feed: AgentIssueEventPage['events'];
let pagesPerCycle: number;
let port: AgentGitHubSourcePort;
let projectId: string;
beforeAll(async () => {
  db = await createIntegrationDatabase();
  runtime = await vi.importActual<typeof import('../index')>('../index');
  accessor = (
    await vi.importActual<typeof import('../resources/agent-source.accessor')>(
      '../resources/agent-source.accessor'
    )
  ).agentSourceAccessor;
}, 30_000);
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});
beforeEach(async () => {
  fixture = await createLedgerFixture(db, runtime);
  await db.prisma.agentSourceState.deleteMany();
  projectId = (
    await db.prisma.agentDefinition.findUniqueOrThrow({ where: { id: fixture.definitionId } })
  ).projectId;
  // Reset is offered to projects with a configured trigger on the source.
  await db.prisma.agentTrigger.update({
    where: { id: fixture.triggerId },
    data: { isConfigured: true },
  });
  pagesPerCycle = 10;
  feed = [{ providerEventId: 'B', payload: null }];
  port = {
    getRepositoryIdentity: () => Promise.resolve({ id: 'repo-1', name: 'org/repo' }),
    listIssueEvents: (input) =>
      Promise.resolve({
        events: feed.slice((input.page - 1) * 100, input.page * 100),
        nextPage: input.page * 100 < feed.length ? input.page + 1 : null,
      }),
    classifyError: () => 'rate_limit',
  };
  await service().prepareBaseline(fixture.connectionId, signal());
});
const signal = () => new AbortController().signal;
const label = (id: string) => ({ providerEventId: id, payload: fixture.github(id).payload });
const control = (id: string) => ({ providerEventId: id, payload: null });
const controls = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) => control(`${prefix}-${i}`));
function service() {
  return new runtime.AgentSourcePollService(port, () => pagesPerCycle);
}
function cycle() {
  return service().pollCycle(signal());
}
function reset(input: { projectId: string; connectionId: string } = currentSource()) {
  return new runtime.AgentManagementService().resetSource(input);
}
function currentSource() {
  return { projectId, connectionId: fixture.connectionId };
}
function state() {
  return db.prisma.agentSourceState.findUniqueOrThrow({
    where: { connectionId: fixture.connectionId },
  });
}
function evaluator() {
  return new runtime.AgentEventEvaluationService({ resolveExecution: async () => executionConfig });
}
/** Task 1 owns the real Enable; this reproduces its contract: a fresh generation and baseline. */
async function enable(triggerId = fixture.triggerId) {
  await db.prisma.agentTrigger.update({
    where: { id: triggerId },
    data: {
      activationState: 'STARTING',
      isEnabled: false,
      activationGeneration: { increment: 1 },
    },
  });
  const prepared = await service().prepareBaseline(fixture.connectionId, signal());
  expect(prepared.boundary).not.toBeNull();
  await db.prisma.agentTrigger.update({
    where: { id: triggerId },
    data: {
      activationState: 'ACTIVE',
      isEnabled: true,
      activationBoundary: prepared.boundary ?? undefined,
    },
  });
  return prepared;
}
/** Every retained proof row, in a stable order, as the database returns it. */
async function proof() {
  const where = { connectionId: fixture.connectionId };
  return {
    pages: await db.prisma.agentSourcePage.findMany({ where, orderBy: { id: 'asc' } }),
    checkpoints: await db.prisma.agentSourceCheckpoint.findMany({
      where,
      orderBy: { scanId: 'asc' },
    }),
    heads: await db.prisma.agentSourceHead.findMany({
      where,
      orderBy: [{ scanId: 'asc' }, { position: 'asc' }],
    }),
    baselines: await db.prisma.agentSourceBaseline.findMany({ where, orderBy: { id: 'asc' } }),
  };
}
type Proof = Awaited<ReturnType<typeof proof>>;
function retained(before: Proof, after: Proof) {
  return {
    pages: after.pages.filter((row) => before.pages.some((old) => old.id === row.id)),
    checkpoints: after.checkpoints.filter((row) =>
      before.checkpoints.some((old) => old.scanId === row.scanId)
    ),
    heads: after.heads.filter((row) =>
      before.heads.some(
        (old) => old.scanId === row.scanId && old.providerEventId === row.providerEventId
      )
    ),
    baselines: after.baselines.filter((row) => before.baselines.some((old) => old.id === row.id)),
  };
}
async function eventOrder(providerEventId: string) {
  const event = await db.prisma.agentEvent.findUnique({
    where: {
      connectionId_providerEventId: { connectionId: fixture.connectionId, providerEventId },
    },
  });
  return event?.sourceOrder ?? null;
}
async function runsFor(providerEventId: string) {
  return await db.prisma.agentRun.count({ where: { event: { providerEventId } } });
}
async function fence() {
  await accessor.setFailure(fixture.connectionId, 'GITHUB_CONTINUITY_LOST', true);
}
/** Order A1, capture part of an interval holding E1, then lose the committed anchor A1. */
async function abandonCaptureOfE1(midCapture: () => Promise<unknown> = async () => undefined) {
  feed = [label('A1'), ...feed];
  await cycle();
  pagesPerCycle = 1;
  feed = [label('E1'), ...controls('x', 100), ...feed];
  await cycle();
  expect(await db.prisma.agentEvent.count({ where: { sourceOrder: null } })).toBe(1);
  await midCapture();
  pagesPerCycle = 10;
  feed = feed.filter((item) => item.providerEventId !== 'A1' && item.providerEventId !== 'B');
  await cycle();
  expect(await state()).toMatchObject({ health: { state: 'RECOVERY_REQUIRED' } });
}

it('pauses every trigger on the connection, cancels queued runs and keeps claimed work', async () => {
  // The source is shared: another project's automation on it is paused too.
  const otherProject = await db.prisma.project.create({
    data: {
      name: 'Other project',
      slug: crypto.randomUUID(),
      repoPath: '/other',
      worktreeBasePath: '/other-wt',
    },
  });
  const other = await db.prisma.agentDefinition.create({
    data: {
      projectId: otherProject.id,
      name: 'Other',
      instructions: 'Other work',
      isEnabled: true,
      triggers: {
        create: {
          id: 'other-trigger',
          type: 'GITHUB_ISSUE',
          connectionId: fixture.connectionId,
          description: 'Shared source',
          config: { version: 1, repositoryIds: ['repo-1'], actions: ['labeled'] },
          isConfigured: true,
          isEnabled: false,
          activationState: 'STARTING',
          activationGeneration: 4,
          pendingActivation: { version: 1 },
        },
      },
    },
  });
  const queued = await fixture.admit(await fixture.event('queued'));
  const claimed = await fixture.admit(await fixture.event('claimed'));
  if (!('runId' in queued && 'runId' in claimed)) {
    throw new Error('Admission failed');
  }
  await db.prisma.agentRun.update({ where: { id: claimed.runId }, data: { status: 'RUNNING' } });
  await fence();

  await expect(reset()).resolves.toEqual({
    connectionId: fixture.connectionId,
    pausedTriggerCount: 2,
    cancelledRunCount: 1,
  });

  expect(
    await db.prisma.agentTrigger.findMany({
      orderBy: { id: 'asc' },
      select: {
        id: true,
        isEnabled: true,
        activationState: true,
        activationGeneration: true,
        activationBoundary: true,
        pendingActivation: true,
      },
    })
  ).toEqual([
    {
      id: 'other-trigger',
      isEnabled: false,
      activationState: 'PAUSED',
      activationGeneration: 5,
      activationBoundary: null,
      pendingActivation: null,
    },
    {
      id: fixture.triggerId,
      isEnabled: false,
      activationState: 'PAUSED',
      activationGeneration: 2,
      activationBoundary: null,
      pendingActivation: null,
    },
  ]);
  expect(await db.prisma.agentRun.findUniqueOrThrow({ where: { id: queued.runId } })).toMatchObject(
    { status: 'CANCELLED', launchPhase: 'FINISHED', reasonCode: 'TRIGGER_DISABLED' }
  );
  expect(
    await db.prisma.agentInitialDelivery.findUnique({ where: { runId: queued.runId } })
  ).toMatchObject({ state: 'FINISHED' });
  expect(
    await db.prisma.agentRun.findUniqueOrThrow({ where: { id: claimed.runId } })
  ).toMatchObject({ status: 'RUNNING' });
  expect(
    await db.prisma.agentDefinition.findUniqueOrThrow({ where: { id: other.id } })
  ).toMatchObject({ isEnabled: true });
  expect((await state()).health).not.toMatchObject({ state: 'RECOVERY_REQUIRED' });
});

it('keeps retained proof unchanged and starts a fresh scan from the current head', async () => {
  let issued!: Awaited<ReturnType<AgentSourcePollService['prepareBaseline']>>;
  let pending!: typeof issued;
  // Pin a committed baseline, and a pending one while the next interval is in flight.
  await abandonCaptureOfE1(async () => {
    issued = await accessor.prepareBaseline(fixture.connectionId, 'A1');
    pending = await service().prepareBaseline(fixture.connectionId, signal());
  });
  expect(issued.boundary).toEqual({ provider: 'GITHUB', headEventId: 'A1', sourceOrder: 1 });
  expect(pending.boundary).toBeNull();
  const before = await proof();
  const beforeState = await state();

  await reset();
  expect(await proof()).toEqual(before);
  expect(await state()).toMatchObject({
    lastSourceOrder: beforeState.lastSourceOrder,
    isReady: false,
    cursor: null,
  });
  expect((await state()).health).not.toMatchObject({ state: 'RECOVERY_REQUIRED' });
  expect(await service().getBaseline(fixture.connectionId, issued.id)).toEqual(issued);
  expect(await service().getBaseline(fixture.connectionId, pending.id)).toEqual(pending);

  // Enable again: the fresh head (still E1, the pending pin) starts the new epoch at the
  // retained high water. The old pin keeps its own answer.
  const fresh = await enable();
  expect(fresh.boundary).toEqual({ provider: 'GITHUB', headEventId: 'E1', sourceOrder: 1 });
  feed = [label('N1'), ...feed];
  await cycle();
  expect(await state()).toMatchObject({
    isReady: true,
    health: { state: 'READY' },
    lastSourceOrder: 2,
    cursor: { committedHeadEventId: 'N1', scan: null },
  });
  expect(await eventOrder('N1')).toBe(2);
  expect(await eventOrder('E1')).toBeNull();
  expect(retained(before, await proof())).toEqual(before);
  expect(await service().getBaseline(fixture.connectionId, issued.id)).toEqual(issued);
  expect(await service().getBaseline(fixture.connectionId, pending.id)).toEqual(pending);

  await evaluator().evaluatePendingEvents(signal());
  expect(await runsFor('N1')).toBe(1);
  expect(await runsFor('A1')).toBe(0);
  expect(await runsFor('E1')).toBe(0);
});

it('never orders an event that was captured but unordered before the reset', async () => {
  await abandonCaptureOfE1();
  await reset();
  feed = [control('C0'), ...feed];
  await enable();
  // The pre-reset capture reappears above the fresh head; it must not become eligible.
  feed = [label('N1'), label('E1'), ...feed.filter((item) => item.providerEventId !== 'E1')];
  await cycle();
  expect(await state()).toMatchObject({ health: { state: 'RECOVERY_REQUIRED' } });
  expect(await eventOrder('E1')).toBeNull();
  expect(await eventOrder('N1')).toBeNull();
  await evaluator().evaluatePendingEvents(signal());
  expect(await db.prisma.agentRun.count()).toBe(0);
});

it('answers historical heads from the new epoch, not the ordinals recorded before the reset', async () => {
  feed = [label('A1'), ...feed];
  await cycle();
  feed = [label('A2'), ...feed];
  await cycle();
  expect(await state()).toMatchObject({ lastSourceOrder: 2 });
  // A2 is deleted at the provider: A1 is the head again but already has ordinal 1.
  feed = feed.filter((item) => item.providerEventId !== 'A2');
  await cycle();
  expect(await state()).toMatchObject({ health: { state: 'RECOVERY_REQUIRED' } });
  await reset();
  expect((await enable()).boundary).toEqual({
    provider: 'GITHUB',
    headEventId: 'A1',
    sourceOrder: 2,
  });
  feed = [label('N1'), ...feed];
  pagesPerCycle = 1;
  await cycle();
  // A baseline read of A1 that commits while the next interval is in flight.
  const raced = await accessor.prepareBaseline(fixture.connectionId, 'A1');
  expect(raced.boundary).toEqual({ provider: 'GITHUB', headEventId: 'A1', sourceOrder: 2 });
  pagesPerCycle = 10;
  for (let i = 0; i < 5; i++) {
    await cycle();
  }
  expect(await eventOrder('N1')).toBe(3);
  expect(await state()).toMatchObject({ health: { state: 'READY' }, lastSourceOrder: 3 });
  expect(
    await db.prisma.agentSourceCheckpoint.count({
      where: { connectionId: fixture.connectionId, status: 'INVALID' },
    })
  ).toBe(0);
  const later = await service().prepareBaseline(fixture.connectionId, signal());
  expect(later.boundary).toEqual({ provider: 'GITHUB', headEventId: 'N1', sourceOrder: 3 });
});

it('lets a new epoch prepare baselines beside rejected historical proof', async () => {
  feed = [label('A1'), ...feed];
  await cycle();
  await db.prisma.agentSourceCheckpoint.create({
    data: { connectionId: fixture.connectionId, scanId: 'rejected', status: 'INVALID' },
  });
  await expect(service().prepareBaseline(fixture.connectionId, signal())).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
  });
  expect(await state()).toMatchObject({ health: { state: 'RECOVERY_REQUIRED' } });
  const before = await proof();
  await reset();
  feed = [label('N1'), ...feed];
  expect((await enable()).boundary).toEqual({
    provider: 'GITHUB',
    headEventId: 'N1',
    sourceOrder: 1,
  });
  expect(retained(before, await proof())).toEqual(before);
});

it('admits no run for an event that was mid-evaluation when the reset committed', async () => {
  const eventId = await fixture.event('inflight');
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const blocked = new runtime.AgentEventEvaluationService({
    resolveExecution: async () => {
      entered();
      await gate;
      return executionConfig;
    },
  });
  const evaluating = blocked.evaluatePendingEvents(signal());
  await started;
  await fence();
  await reset();
  release();
  await evaluating;
  expect(await db.prisma.agentRun.count()).toBe(0);
  expect(await db.prisma.agentEvaluation.count({ where: { eventId, runId: { not: null } } })).toBe(
    0
  );

  // A matched decision recorded before the reset but not yet admitted is never admitted either.
  await enable();
  const pending = await fixture.event('pending');
  const generation = (
    await db.prisma.agentTrigger.findUniqueOrThrow({ where: { id: fixture.triggerId } })
  ).activationGeneration;
  const decision = await fixture.evaluation(pending, { activationGeneration: generation });
  if (!('evaluationId' in decision)) {
    throw new Error(JSON.stringify(decision));
  }
  await fence();
  await reset();
  await expect(
    runtime.admitRun({
      evaluationId: decision.evaluationId,
      definitionRevision: 1,
      triggerRevision: 1,
      activationGeneration: generation,
    })
  ).resolves.toMatchObject({ status: 'REJECTED' });
  await evaluator().evaluatePendingEvents(signal());
  expect(await db.prisma.agentRun.count()).toBe(0);
});

it('refuses a healthy source and leaves it untouched', async () => {
  const before = await state();
  await expect(reset()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  expect(await state()).toEqual(before);
  expect(
    await db.prisma.agentTrigger.findUniqueOrThrow({ where: { id: fixture.triggerId } })
  ).toMatchObject({ activationState: 'ACTIVE', isEnabled: true, activationGeneration: 1 });
});

it('treats a repeated reset as a no-op until the source has a fresh head', async () => {
  await fence();
  await expect(reset()).resolves.toMatchObject({ pausedTriggerCount: 1 });
  const after = await state();
  const proofAfter = await proof();
  // A user may click Enable between two reset requests; the repeat must not undo it.
  await db.prisma.agentTrigger.update({
    where: { id: fixture.triggerId },
    data: { activationState: 'STARTING', activationGeneration: { increment: 1 } },
  });
  await expect(reset()).resolves.toEqual({
    connectionId: fixture.connectionId,
    pausedTriggerCount: 0,
    cancelledRunCount: 0,
  });
  expect(await state()).toEqual(after);
  expect(await proof()).toEqual(proofAfter);
  expect(
    await db.prisma.agentTrigger.findUniqueOrThrow({ where: { id: fixture.triggerId } })
  ).toMatchObject({ activationState: 'STARTING', activationGeneration: 3 });
  await service().prepareBaseline(fixture.connectionId, signal());
  await expect(reset()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
});

it('requires a configured trigger of the calling project on the connection', async () => {
  await db.prisma.agentTrigger.update({
    where: { id: fixture.triggerId },
    data: { isConfigured: null },
  });
  await fence();
  const before = await state();
  const foreign = await db.prisma.project.create({
    data: {
      name: 'Foreign',
      slug: crypto.randomUUID(),
      repoPath: '/foreign',
      worktreeBasePath: '/foreign-wt',
    },
  });
  await expect(
    reset({ projectId: foreign.id, connectionId: fixture.connectionId })
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  // The fixture trigger has unknown (legacy) membership, which is not a configured trigger.
  await expect(reset()).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(reset({ projectId, connectionId: 'missing-connection' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
  expect(await state()).toEqual(before);
  await db.prisma.agentTrigger.update({
    where: { id: fixture.triggerId },
    data: { isConfigured: true },
  });
  await expect(reset()).resolves.toMatchObject({ connectionId: fixture.connectionId });
});
