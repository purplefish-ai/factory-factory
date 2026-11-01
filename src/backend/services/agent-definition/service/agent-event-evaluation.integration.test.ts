import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  createLedgerFixture,
  executionConfig,
} from '@/backend/services/agent-definition/resources/testing/agent-ledger.test-support';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
let db: IntegrationDatabase;
let runtime: typeof import('../index');
let fixture: Awaited<ReturnType<typeof createLedgerFixture>>;
beforeAll(async () => {
  db = await createIntegrationDatabase();
  runtime = await vi.importActual('../index');
}, 30_000);
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});
beforeEach(async () => {
  fixture = await createLedgerFixture(db, runtime);
});
function evaluator(resolveExecution = async () => executionConfig) {
  expect(runtime.AgentEventEvaluationService).toBeTypeOf('function');
  return new runtime.AgentEventEvaluationService({ resolveExecution });
}
const signal = () => new AbortController().signal;
it('evaluates overlapping triggers once, freezes the first context and coalesces every match', async () => {
  await fixture.secondTrigger();
  await fixture.event();
  const service = evaluator();
  await service.evaluatePendingEvents(signal());
  await service.evaluatePendingEvents(signal());
  const run = await db.prisma.agentRun.findFirstOrThrow();
  expect(run).toMatchObject({
    status: 'QUEUED',
    triggerId: 'trigger-a',
    definitionSnapshot: { executionConfig },
  });
  expect(await db.prisma.agentRun.count()).toBe(1);
  expect(await db.prisma.agentEvaluation.findMany({ orderBy: { triggerId: 'asc' } })).toMatchObject(
    [
      { status: 'MATCHED', triggerId: 'trigger-a', runId: run.id },
      { status: 'MATCHED', triggerId: 'trigger-b', runId: run.id },
    ]
  );
});
it('holds STARTING candidates and never revives a paused-time terminal decision after re-enable', async () => {
  await db.prisma.agentTrigger.update({
    where: { id: fixture.triggerId },
    data: { activationState: 'STARTING', isEnabled: false },
  });
  await fixture.event();
  const service = evaluator();
  await service.evaluatePendingEvents(signal());
  expect(await db.prisma.agentEvaluation.count()).toBe(0);
  await db.prisma.agentTrigger.update({
    where: { id: fixture.triggerId },
    data: { activationState: 'PAUSED' },
  });
  await service.evaluatePendingEvents(signal());
  expect(await db.prisma.agentEvaluation.findFirstOrThrow()).toMatchObject({
    status: 'SKIPPED',
    reasonCode: 'TRIGGER_DISABLED',
  });
  await db.prisma.agentTrigger.update({
    where: { id: fixture.triggerId },
    data: { isEnabled: true, activationState: 'ACTIVE', activationGeneration: 2 },
  });
  await service.evaluatePendingEvents(signal());
  expect(await db.prisma.agentRun.count()).toBe(0);
  expect(await db.prisma.agentEvaluation.count()).toBe(1);
});
it('blocks later context behind an earlier ERROR and retries on the durable 30s, 2m, 10m budget', async () => {
  await fixture.secondTrigger();
  await fixture.event();
  let attempts = 0;
  let now = new Date();
  const service = new runtime.AgentEventEvaluationService({
    resolveExecution: () => {
      attempts++;
      return Promise.reject(new Error('temporary database read'));
    },
    now: () => now,
  });
  expect(service.evaluatePendingEvents).toBeTypeOf('function');
  await service.evaluatePendingEvents(signal());
  for (const [delay, attemptCount] of [
    [30_000, 1],
    [120_000, 2],
    [600_000, 3],
  ] as const) {
    expect(
      await db.prisma.agentEvaluation.findFirstOrThrow({ orderBy: { triggerId: 'asc' } })
    ).toMatchObject({
      status: 'ERROR',
      attemptCount,
      nextAttemptAt: new Date(now.getTime() + delay),
    });
    await service.evaluatePendingEvents(signal());
    expect(attempts).toBe(attemptCount * 2);
    now = new Date(now.getTime() + delay);
    await service.evaluatePendingEvents(signal());
  }
  expect(await db.prisma.agentEvaluation.findFirstOrThrow()).toMatchObject({
    attemptCount: 4,
    nextAttemptAt: null,
  });
  now = new Date(now.getTime() + 3_600_000);
  await service.evaluatePendingEvents(signal());
  expect(attempts).toBe(8);
  expect(await db.prisma.agentRun.count()).toBe(0);
});
it('does not admit stale settings when the definition changes while resolving defaults', async () => {
  await fixture.event();
  await evaluator(async () => {
    await db.prisma.agentDefinition.update({
      where: { id: fixture.definitionId },
      data: { definitionRevision: 2, isEnabled: false },
    });
    return executionConfig;
  }).evaluatePendingEvents(signal());
  expect(await db.prisma.agentRun.count()).toBe(0);
  expect(await db.prisma.agentEvaluation.count()).toBe(0);
});
it('stores permanent malformed configuration errors without retry and excludes SCHEDULE', async () => {
  await fixture.event();
  await db.prisma.agentDefinition.update({
    where: { id: fixture.definitionId },
    data: { executionConfig: { version: 999 } },
  });
  await evaluator().evaluatePendingEvents(signal());
  expect(await db.prisma.agentEvaluation.findFirstOrThrow()).toMatchObject({
    status: 'ERROR',
    reasonCode: 'INVALID_STORED_DATA',
    nextAttemptAt: null,
  });
  await db.prisma.agentTrigger.update({
    where: { id: fixture.triggerId },
    data: { type: 'SCHEDULE' },
  });
  await evaluator().evaluatePendingEvents(signal());
  expect(await db.prisma.agentRun.count()).toBe(0);
});

it('keeps later matches behind the first error, then carries used retries into its launch budget', async () => {
  await fixture.secondTrigger();
  await fixture.event();
  let first = true;
  let now = new Date();
  const service = new runtime.AgentEventEvaluationService({
    resolveExecution: () => {
      if (first) {
        first = false;
        return Promise.reject(new Error('Temporary read failure'));
      }
      return Promise.resolve(executionConfig);
    },
    now: () => now,
  });
  await service.evaluatePendingEvents(signal());
  expect(await db.prisma.agentEvaluation.findMany({ orderBy: { triggerId: 'asc' } })).toMatchObject(
    [
      { triggerId: 'trigger-a', status: 'ERROR' },
      { triggerId: 'trigger-b', status: 'MATCHED', runId: null },
    ]
  );
  expect(await db.prisma.agentRun.count()).toBe(0);
  now = new Date(now.getTime() + 30_000);
  await service.evaluatePendingEvents(signal());
  const run = await db.prisma.agentRun.findFirstOrThrow();
  expect(run).toMatchObject({ triggerId: 'trigger-a', attemptCount: 1 });
  expect(await runtime.claimNextRun(now)).toMatchObject({ status: 'CLAIMED', runId: run.id });
  expect(await db.prisma.agentRun.findFirstOrThrow()).toMatchObject({ attemptCount: 2 });
  expect(await db.prisma.agentEvaluation.count({ where: { runId: run.id } })).toBe(2);
});
it('honors Retry-After and does not store provider error text', async () => {
  await fixture.event();
  const now = new Date();
  const service = new runtime.AgentEventEvaluationService({
    resolveExecution: () => Promise.reject(new Error('secret credential')),
    classifyError: () => ({ retryable: true, retryAfterMs: 90_000 }),
    now: () => now,
  });
  await service.evaluatePendingEvents(signal());
  const evaluation = await db.prisma.agentEvaluation.findFirstOrThrow();
  expect(evaluation.nextAttemptAt).toEqual(new Date(now.getTime() + 90_000));
  expect(JSON.stringify(evaluation)).not.toContain('secret credential');
});
it.each(['pause', 'revision'] as const)(
  'settles pending unadmitted matches after %s without reevaluation',
  async (change) => {
    const eventId = await fixture.event();
    await fixture.evaluation(eventId);
    await db.prisma.agentTrigger.update({
      where: { id: fixture.triggerId },
      data:
        change === 'pause'
          ? { isEnabled: false, activationState: 'PAUSED' }
          : { triggerRevision: 2, activationGeneration: 2 },
    });
    await evaluator(() =>
      Promise.reject(new Error('Must not resolve historical settings'))
    ).evaluatePendingEvents(signal());
    expect(await db.prisma.agentEvaluation.findFirstOrThrow()).toMatchObject({
      status: 'SKIPPED',
      reasonCode: change === 'pause' ? 'TRIGGER_DISABLED' : 'STALE_REVISION',
      triggerRevision: 1,
      activationGeneration: 1,
    });
    expect(await db.prisma.agentRun.count()).toBe(0);
  }
);
it('resolves provider-specific saved defaults and preserves explicit execution overrides', async () => {
  const { userSettingsService } = await vi.importActual<
    typeof import('@/backend/services/settings')
  >('@/backend/services/settings');
  const { createSessionProviderResolverService } = await vi.importActual<
    typeof import('@/backend/services/session')
  >('@/backend/services/session');
  const { resolveAgentExecutionConfig } = await vi.importActual<
    typeof import('@/backend/orchestration/agent-runtime.orchestrator')
  >('@/backend/orchestration/agent-runtime.orchestrator');
  await userSettingsService.update({
    defaultSessionProvider: 'CODEX',
    defaultClaudeModel: 'opus',
    defaultCodexModel: 'gpt-6-luna',
    defaultCodexReasoningEffort: 'high',
    defaultClaudeReasoningEffort: 'medium',
  });
  const services = {
    userSettingsQueryService: userSettingsService,
    sessionProviderResolverService: createSessionProviderResolverService({
      getDefaultSessionProvider: () => userSettingsService.getDefaultSessionProvider(),
      getModelDefaults: () => userSettingsService.get(),
      findWorkspace: async () => null,
    }),
  };
  expect(await resolveAgentExecutionConfig(services, { version: 1 })).toEqual({
    version: 1,
    provider: 'CODEX',
    model: 'gpt-6-luna',
    reasoningEffort: 'high',
  });
  expect(
    await resolveAgentExecutionConfig(services, {
      version: 1,
      provider: 'CLAUDE',
      model: 'sonnet',
      reasoningEffort: 'low',
    })
  ).toEqual({ version: 1, provider: 'CLAUDE', model: 'sonnet', reasoningEffort: 'low' });
});
