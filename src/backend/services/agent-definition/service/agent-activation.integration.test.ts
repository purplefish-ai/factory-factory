import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  createLedgerFixture,
  validatedIntent,
} from '@/backend/services/agent-definition/resources/testing/agent-ledger.test-support';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import type { AgentGitHubSourcePort, AgentIssueEventPage } from '@/shared/agent-source';
import { Prisma } from '@prisma-gen/client';

let db: IntegrationDatabase;
let runtime: typeof import('../index');
let fixture: Awaited<ReturnType<typeof createLedgerFixture>>;
let feed: AgentIssueEventPage['events'];
let failSource: boolean;
let clock: Date;
let projectId: string;
let port: AgentGitHubSourcePort;

beforeAll(async () => {
  db = await createIntegrationDatabase();
  runtime = await vi.importActual<typeof import('../index')>('../index');
}, 30_000);
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});
beforeEach(async () => {
  fixture = await createLedgerFixture(db, runtime);
  projectId = (
    await db.prisma.agentDefinition.findUniqueOrThrow({ where: { id: fixture.definitionId } })
  ).projectId;
  feed = [];
  failSource = false;
  clock = new Date();
  port = {
    getRepositoryIdentity: async () => ({ id: 'repo-1', name: 'org/repo' }),
    listIssueEvents: (input, signal) => {
      signal?.throwIfAborted();
      if (failSource) {
        return Promise.reject(new Error('GitHub unavailable'));
      }
      return Promise.resolve({
        events: feed.slice((input.page - 1) * 100, input.page * 100),
        nextPage: input.page * 100 < feed.length ? input.page + 1 : null,
      });
    },
    classifyError: () => 'unknown',
  };
});

const signal = () => new AbortController().signal;
const label = (id: string) => ({ providerEventId: id, payload: fixture.github(id).payload });
function poller() {
  return new runtime.AgentSourcePollService(port, () => 10);
}
function activation() {
  return new runtime.AgentActivationService(poller(), () => clock);
}
function evaluator() {
  return new runtime.AgentEventEvaluationService({
    resolveExecution: async () => ({ version: 1, provider: 'CLAUDE', model: 'sonnet' }),
  });
}
async function cycle() {
  await poller().pollCycle(signal());
  await activation().completePending(signal());
}
function trigger(id = fixture.triggerId) {
  return db.prisma.agentTrigger.findUniqueOrThrow({ where: { id } });
}
function definition() {
  return db.prisma.agentDefinition.findUniqueOrThrow({ where: { id: fixture.definitionId } });
}
/** A saved, paused automation over a source whose committed head is B. */
async function pausedAutomation() {
  await db.prisma.agentDefinition.update({
    where: { id: fixture.definitionId },
    data: { isEnabled: false, validatedIntent: Prisma.DbNull },
  });
  await db.prisma.agentTrigger.update({
    where: { id: fixture.triggerId },
    data: {
      isEnabled: false,
      activationState: 'PAUSED',
      activationGeneration: 0,
      activationBoundary: Prisma.DbNull,
    },
  });
  await db.prisma.agentSourceState.update({
    where: { connectionId: fixture.connectionId },
    data: {
      isReady: true,
      cursor: { version: 1, provider: 'GITHUB', committedHeadEventId: 'B', scan: null },
      health: { state: 'READY', reasonCode: null, updatedAt: new Date().toISOString() },
    },
  });
  feed = [{ providerEventId: 'B', payload: null }];
}
async function begin(overrides: Record<string, unknown> = {}) {
  const current = await definition();
  await activation().begin(
    {
      projectId,
      agentId: fixture.definitionId,
      expectedManagementRevision: current.managementRevision,
      definitionRevision: current.definitionRevision,
      projectSource: { githubOwner: 'org', githubRepo: 'repo' },
      execution: validatedIntent(current.definitionRevision).execution,
      triggerIds: [fixture.triggerId],
      ...overrides,
    },
    signal()
  );
}

it('persists validated intent, waits STARTING for its baseline, then activates at that boundary', async () => {
  await pausedAutomation();
  feed = [label('N'), ...feed];
  await begin();
  const starting = await trigger();
  expect(starting).toMatchObject({
    activationState: 'STARTING',
    activationGeneration: 1,
    activationBoundary: null,
    isEnabled: false,
  });
  expect(starting.pendingActivation).toMatchObject({
    provider: 'GITHUB',
    activationGeneration: 1,
    baselineId: expect.any(String),
  });
  const enabled = await definition();
  expect(enabled.isEnabled).toBe(true);
  expect(enabled.managementRevision).toBe(2);
  expect(enabled.validatedIntent).toMatchObject({ version: 1, definitionRevision: 1 });

  await cycle();
  expect(await trigger()).toMatchObject({
    activationState: 'ACTIVE',
    isEnabled: true,
    activationGeneration: 1,
    pendingActivation: null,
    pausedReasonCode: null,
    activationBoundary: { provider: 'GITHUB', headEventId: 'N', sourceOrder: 1 },
  });

  // N is the baseline head: it never runs. M arrives after the boundary and does.
  feed = [label('M'), ...feed];
  await cycle();
  await evaluator().evaluatePendingEvents(signal());
  const evaluations = await db.prisma.agentEvaluation.findMany({
    include: { event: true },
    orderBy: { createdAt: 'asc' },
  });
  expect(
    Object.fromEntries(evaluations.map((row) => [row.event.providerEventId, row.reasonCode]))
  ).toEqual({ N: 'BEFORE_ACTIVATION', M: 'DETERMINISTIC_MATCH' });
  const runs = await db.prisma.agentRun.findMany({ include: { event: true } });
  expect(runs.map((run) => [run.event?.providerEventId, run.status])).toEqual([['M', 'QUEUED']]);
});

it('activates immediately when the first baseline initializes the source', async () => {
  await pausedAutomation();
  await db.prisma.agentSourceState.deleteMany();
  feed = [label('H')];
  await begin();
  expect(await trigger()).toMatchObject({
    activationState: 'ACTIVE',
    activationBoundary: { provider: 'GITHUB', headEventId: 'H', sourceOrder: 0 },
  });
});

it('refuses stale management or definition revisions without changing state', async () => {
  await pausedAutomation();
  await expect(begin({ expectedManagementRevision: 7 })).rejects.toMatchObject({
    code: 'CONFLICT',
  });
  await expect(begin({ definitionRevision: 2 })).rejects.toMatchObject({ code: 'CONFLICT' });
  await expect(begin({ projectId: 'foreign' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(
    begin({ projectSource: { githubOwner: 'org', githubRepo: 'renamed' } })
  ).rejects.toMatchObject({ code: 'CONFLICT' });
  await expect(begin({ triggerIds: [] })).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
  });
  expect(await trigger()).toMatchObject({ activationState: 'PAUSED', activationGeneration: 0 });
  expect(await definition()).toMatchObject({
    isEnabled: false,
    managementRevision: 1,
    validatedIntent: null,
  });
});

it('expires a STARTING trigger whose baseline never resolves', async () => {
  await pausedAutomation();
  feed = [label('N'), ...feed];
  await begin();
  failSource = true;
  await cycle();
  expect((await trigger()).activationState).toBe('STARTING');
  clock = new Date(clock.getTime() + 30 * 60 * 1000);
  await cycle();
  expect(await trigger()).toMatchObject({
    activationState: 'PAUSED',
    pausedReasonCode: 'ACTIVATION_EXPIRED',
    activationGeneration: 2,
    pendingActivation: null,
    activationBoundary: null,
  });
});

it('returns to PAUSED with a source reason when the baseline cannot be prepared', async () => {
  await pausedAutomation();
  failSource = true;
  await begin();
  expect(await trigger()).toMatchObject({
    activationState: 'PAUSED',
    pausedReasonCode: 'SOURCE_ERROR',
    activationGeneration: 2,
  });

  failSource = false;
  feed = [label('N'), ...feed];
  await begin();
  expect((await trigger()).pausedReasonCode).toBeNull();
  await db.prisma.agentSourceState.update({
    where: { connectionId: fixture.connectionId },
    data: {
      health: {
        state: 'RECOVERY_REQUIRED',
        reasonCode: 'GITHUB_CONTINUITY_LOST',
        updatedAt: new Date().toISOString(),
      },
    },
  });
  await activation().completePending(signal());
  expect(await trigger()).toMatchObject({
    activationState: 'PAUSED',
    pausedReasonCode: 'SOURCE_RECOVERY_REQUIRED',
  });
});

it('does not activate over malformed source health', async () => {
  await pausedAutomation();
  feed = [label('N'), ...feed];
  await begin();
  await db.prisma.agentSourceState.update({
    where: { connectionId: fixture.connectionId },
    data: { health: { state: 'UNKNOWN' } },
  });
  await activation().completePending(signal());
  expect(await trigger()).toMatchObject({
    activationState: 'PAUSED',
    pausedReasonCode: 'SOURCE_ERROR',
    activationBoundary: null,
  });
});

it('does not activate a definition whose validated intent is no longer current', async () => {
  await pausedAutomation();
  feed = [label('N'), ...feed];
  await begin();
  await db.prisma.agentDefinition.update({
    where: { id: fixture.definitionId },
    data: { validatedIntent: validatedIntent(2) },
  });
  await cycle();
  expect(await trigger()).toMatchObject({ activationState: 'PAUSED', activationBoundary: null });
});

it('pauses every trigger, cancels queued runs and lets claimed runs finish', async () => {
  await fixture.secondTrigger();
  const claimed = await fixture.admit(await fixture.event('event-1'));
  const queued = await fixture.admit(await fixture.event('event-2'));
  if (!('runId' in claimed && 'runId' in queued)) {
    throw new Error('Expected admitted runs');
  }
  expect(await runtime.claimNextRun()).toMatchObject({ status: 'CLAIMED', runId: claimed.runId });
  const current = await definition();
  await expect(
    activation().pause({
      projectId,
      agentId: fixture.definitionId,
      expectedManagementRevision: current.managementRevision + 1,
    })
  ).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(
    await activation().pause({
      projectId,
      agentId: fixture.definitionId,
      expectedManagementRevision: current.managementRevision,
    })
  ).toEqual({ pausedTriggerCount: 2, cancelledRunCount: 1 });
  for (const id of [fixture.triggerId, 'trigger-b']) {
    expect(await trigger(id)).toMatchObject({
      activationState: 'PAUSED',
      isEnabled: false,
      activationGeneration: 2,
      activationBoundary: null,
      pendingActivation: null,
    });
  }
  expect(await definition()).toMatchObject({ isEnabled: false, managementRevision: 2 });
  const runs = await db.prisma.agentRun.findMany({ include: { initialDelivery: true } });
  expect(runs.find((run) => run.id === claimed.runId)?.status).toBe('RUNNING');
  expect(runs.find((run) => run.id === queued.runId)).toMatchObject({
    status: 'CANCELLED',
    reasonCode: 'STALE_REVISION',
    initialDelivery: { state: 'FINISHED' },
  });
});

it.each([null, false])(
  'never targets, evaluates, admits or claims for a trigger with isConfigured %s',
  async (isConfigured) => {
    const matched = await fixture.evaluation(await fixture.event('event-1'));
    const admitted = await fixture.admit(await fixture.event('event-2'));
    await fixture.event('event-3');
    await db.prisma.agentTrigger.update({
      where: { id: fixture.triggerId },
      data: { isConfigured },
    });
    if (!('evaluationId' in matched && 'runId' in admitted)) {
      throw new Error('Expected a decision and an admitted run');
    }
    expect(
      await runtime.admitRun({
        evaluationId: matched.evaluationId,
        definitionRevision: 1,
        triggerRevision: 1,
        activationGeneration: 1,
      })
    ).toEqual({ status: 'REJECTED', reason: 'TRIGGER_DISABLED' });
    expect(await runtime.claimNextRun()).toMatchObject({ status: 'DEFERRED' });
    expect(
      await db.prisma.agentRun.findUniqueOrThrow({ where: { id: admitted.runId } })
    ).toMatchObject({ status: 'CANCELLED', reasonCode: 'TRIGGER_DISABLED' });
    await evaluator().evaluatePendingEvents(signal());
    const third = await db.prisma.agentEvent.findFirstOrThrow({
      where: { providerEventId: 'event-3' },
    });
    expect(await db.prisma.agentEvaluation.count({ where: { eventId: third.id } })).toBe(0);
    const listIssueEvents = vi.spyOn(port, 'listIssueEvents');
    await poller().pollCycle(signal());
    expect(listIssueEvents).not.toHaveBeenCalled();
    await expect(poller().prepareBaseline(fixture.connectionId, signal())).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
  }
);

it('refuses admission when the validated intent is not for the current definition revision', async () => {
  const matched = await fixture.evaluation(await fixture.event('event-1'));
  if (!('evaluationId' in matched)) {
    throw new Error('Expected a decision');
  }
  await db.prisma.agentDefinition.update({
    where: { id: fixture.definitionId },
    data: { validatedIntent: validatedIntent(2) },
  });
  expect(
    await runtime.admitRun({
      evaluationId: matched.evaluationId,
      definitionRevision: 1,
      triggerRevision: 1,
      activationGeneration: 1,
    })
  ).toEqual({ status: 'REJECTED', reason: 'EXECUTION_NOT_VALIDATED' });
  await db.prisma.agentDefinition.update({
    where: { id: fixture.definitionId },
    data: { validatedIntent: Prisma.DbNull },
  });
  expect(
    await runtime.admitRun({
      evaluationId: matched.evaluationId,
      definitionRevision: 1,
      triggerRevision: 1,
      activationGeneration: 1,
    })
  ).toEqual({ status: 'REJECTED', reason: 'EXECUTION_NOT_VALIDATED' });
  expect(await db.prisma.agentRun.count()).toBe(0);
});

function sourceState() {
  return db.prisma.agentSourceState.findUniqueOrThrow({
    where: { connectionId: fixture.connectionId },
  });
}

it.each(['paused', 'deleted'] as const)(
  'leaves source health alone for other automations when one is %s while its baseline is prepared',
  async (change) => {
    await pausedAutomation();
    feed = [label('N'), ...feed];
    // Another automation on the same repository that listened before and is now paused.
    const other = await db.prisma.agentDefinition.create({
      data: { projectId, name: 'Triage', instructions: 'Triage issues', isEnabled: false },
    });
    await db.prisma.agentTrigger.create({
      data: {
        id: 'trigger-other',
        agentDefinitionId: other.id,
        connectionId: fixture.connectionId,
        type: 'GITHUB_ISSUE',
        description: 'Triage labels',
        config: { version: 1, repositoryIds: ['repo-1'], actions: ['labeled'] },
        isEnabled: false,
        isConfigured: true,
        activationState: 'PAUSED',
        activationGeneration: 1,
      },
    });
    const read = port.listIssueEvents;
    port.listIssueEvents = async (input, readSignal) => {
      // The user acts while Enable reads the provider head.
      const owner = { projectId, agentId: fixture.definitionId };
      const { managementRevision } = await definition();
      if (change === 'paused') {
        await activation().pause({ ...owner, expectedManagementRevision: managementRevision });
      } else {
        await new runtime.AgentManagementService().delete({
          ...owner,
          expectedManagementRevision: managementRevision,
        });
      }
      return read(input, readSignal);
    };
    await begin();

    if (change === 'paused') {
      expect(await trigger()).toMatchObject({
        activationState: 'PAUSED',
        pausedReasonCode: null,
        pendingActivation: null,
      });
    } else {
      expect(await db.prisma.agentTrigger.count({ where: { id: fixture.triggerId } })).toBe(0);
    }
    expect(await sourceState()).toMatchObject({
      isReady: true,
      health: { state: 'READY', reasonCode: null },
    });
    const otherRead = await new runtime.AgentManagementService().get({
      projectId,
      agentId: other.id,
    });
    expect(otherRead.configuredTriggers[0]?.sourceHealth).toMatchObject({
      state: 'READY',
      reasonCode: null,
    });
  }
);

it('still records a real provider failure as source health', async () => {
  await pausedAutomation();
  port.classifyError = () => 'auth_required';
  failSource = true;
  await begin();
  expect(await sourceState()).toMatchObject({
    isReady: false,
    health: { state: 'ERROR', reasonCode: 'GITHUB_AUTH_REQUIRED' },
  });
});
