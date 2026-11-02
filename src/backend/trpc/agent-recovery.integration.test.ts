import { createExpressMiddleware } from '@trpc/server/adapters/express';
import express from 'express';
import request from 'supertest';
import { beforeEach, expect, it, vi } from 'vitest';
import type { AppContext, AppServices } from '@/backend/app-context';
import { FORWARDED_CLIENT_ADDRESS_HEADERS } from '@/shared/proxy-utils';
import {
  db,
  h,
  consumer,
  providers,
  launch,
  strictStop,
  recoveryWorktree,
} from '@/test-utils/event-generic-retry.test-support';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';

// Unexpected account/profile/native work must fail before filesystem or process effects.
vi.mock('@/backend/services/codex-accounts/service/profile', () => {
  const denied = () => {
    throw new Error('Unexpected account profile work');
  };
  return {
    resolveAccountContext: denied,
    prepareAccountContext: denied,
    resolveHistoryContext: denied,
    createLoginStage: denied,
    adoptLoginStage: denied,
    discardLoginStage: denied,
  };
});
vi.mock('@/backend/services/codex-accounts/service/native-account', () => {
  const denied = () => {
    throw new Error('Unexpected native account work');
  };
  return { probeNativeIdentity: denied, probeNativeAccount: denied, loginNativeAccount: denied };
});

let agentRouter: typeof import('./agent.trpc').agentRouter;
let services: AppServices;
let createContext: typeof import('./trpc').createContext;
let scope: { projectId: string; agentId: string; runId: string };
beforeEach(async () => {
  ({ agentRouter } = await vi.importActual<typeof import('./agent.trpc')>('./agent.trpc'));
  ({ createContext } = await vi.importActual<typeof import('./trpc')>('./trpc'));
  const { createAgentManagement } = await vi.importActual<
    typeof import('@/backend/orchestration/agent-management.orchestrator')
  >('@/backend/orchestration/agent-management.orchestrator');
  const run = await db.prisma.agentRun.findUniqueOrThrow({ where: { id: h.claim.runId } });
  scope = { projectId: h.workspaceSource.projectId, agentId: run.agentDefinitionId, runId: run.id };
  services = unsafeCoerce<AppServices>({
    agentManagementService: h.owner.agentManagementService,
    workspaceDataService: h.workspace.workspaceDataService,
    agentRuntime: { recovery: consumer },
    configService: {
      getCorsConfig: () => ({
        allowedOrigins: ['http://localhost:3000'],
        trustedLocalCidrs: [],
        trustProxyHeaders: false,
        disableCorsChecks: false,
      }),
    },
  });
  services.agentManagement = createAgentManagement(() => services);
});
function app(remote = false) {
  const server = express();
  if (remote) {
    server.use((req, _res, next) => {
      Object.defineProperty(req.socket, 'remoteAddress', { value: '203.0.113.1' });
      next();
    });
  }
  server.use(
    '/api/trpc',
    createExpressMiddleware({
      router: agentRouter,
      createContext: createContext(unsafeCoerce<AppContext>({ services })),
    })
  );
  return server;
}
const target = () =>
  request(app())
    .get('/api/trpc/recoveryTarget')
    .query({ input: JSON.stringify({ json: scope }) });
const inspect = (input: unknown) =>
  request(app())
    .get('/api/trpc/inspectRun')
    .query({ input: JSON.stringify({ json: input }) });
const action = (input: unknown) =>
  request(app()).post('/api/trpc/resolveAmbiguousRun').send({ json: input });

it('reads an exact scoped target without effects and keeps history insufficient for recovery', async () => {
  const before = await db.prisma.agentRun.findUniqueOrThrow({ where: { id: scope.runId } });
  const response = await target();
  expect(response.status).toBe(200);
  expect(response.body.result.data.json).toMatchObject({
    status: 'AVAILABLE',
    ...scope,
    context: { projectId: scope.projectId, claim: h.claim, attempt: h.attempt },
  });
  expect(await db.prisma.agentRun.findUniqueOrThrow({ where: { id: scope.runId } })).toEqual(
    before
  );
  expect(providers).toHaveLength(0);
  const history = await services.agentManagement.runs({
    projectId: scope.projectId,
    agentId: scope.agentId,
  });
  expect(history.items[0]).not.toHaveProperty('workerGeneration');
  expect(history.items[0]).not.toHaveProperty('initialMessageId');
  expect(history.items[0]?.delivery).not.toHaveProperty('messageId');
  const result = await inspect({
    agentId: scope.agentId,
    projectId: scope.projectId,
    claim: h.claim,
    attempt: h.attempt,
  });
  expect(result.status).toBe(200);
  expect(result.body.result.data.json).toMatchObject({
    delivery: 'UNSENT',
    blocked: 'SOURCE_UNAVAILABLE',
    proofAvailable: false,
  });
  expect(JSON.stringify(result.body)).not.toContain('Frozen task');
  expect(JSON.stringify(result.body)).not.toContain('Frozen issue');
});

it('fails closed for foreign, missing, terminal and inconsistent targets without effects', async () => {
  const foreign = await db.prisma.agentDefinition.create({
    data: { projectId: scope.projectId, name: 'Other', instructions: 'Other' },
  });
  const snapshots = await db.prisma.agentRun.findMany();
  for (const replacement of [
    { projectId: 'foreign' },
    { agentId: foreign.id },
    { runId: 'missing-retained-run' },
  ]) {
    const response = await request(app())
      .get('/api/trpc/recoveryTarget')
      .query({ input: JSON.stringify({ json: { ...scope, ...replacement } }) });
    expect(response.status).toBe(200);
    expect(response.body.result.data.json).toMatchObject({
      status: 'UNAVAILABLE',
      reason: 'NOT_FOUND',
    });
    expect(response.body.result.data.json).not.toHaveProperty('context');
  }
  expect(await db.prisma.agentRun.findMany()).toEqual(snapshots);
  await db.prisma.agentInitialDelivery.update({
    where: { runId: scope.runId },
    data: { attemptGeneration: 2 },
  });
  expect((await target()).body.result.data.json).toMatchObject({
    status: 'UNAVAILABLE',
    reason: 'INVALID_STORED_DATA',
  });
  await db.prisma.agentRun.update({
    where: { id: scope.runId },
    data: { status: 'CANCELLED', launchPhase: 'FINISHED' },
  });
  expect((await target()).body.result.data.json).toMatchObject({
    status: 'UNAVAILABLE',
    reason: 'NOT_RECOVERABLE',
  });
  expect(providers).toHaveLength(0);
});

const fullInput = () => ({
  projectId: scope.projectId,
  agentId: scope.agentId,
  claim: h.claim,
  attempt: h.attempt,
});

it('rejects every stale or mixed exact-context field through HTTP before touching the active provider', async () => {
  await launch();
  const foreign = await db.prisma.agentDefinition.create({
    data: { projectId: scope.projectId, name: 'Other', instructions: 'Other' },
  });
  const input = fullInput();
  const invalid = [
    { ...input, projectId: 'foreign' },
    { ...input, agentId: foreign.id },
    ...['workerGeneration', 'attemptGeneration'].map((key) => ({
      ...input,
      claim: { ...input.claim, [key]: 2 },
    })),
    ...['reservedWorkspaceId', 'reservedSessionId', 'initialMessageId', 'runId'].map((key) => ({
      ...input,
      claim: { ...input.claim, [key]: 'wrong' },
    })),
    ...['workerGeneration', 'attemptGeneration'].map((key) => ({
      ...input,
      attempt: { ...input.attempt, [key]: 2 },
    })),
    ...['runId', 'sessionId', 'messageId', 'sendAttemptId'].map((key) => ({
      ...input,
      attempt: { ...input.attempt, [key]: 'wrong' },
    })),
  ];
  const before = await db.prisma.agentRun.findMany();
  const delivery = await h.read();
  for (const context of invalid) {
    expect((await inspect(context)).status).toBeGreaterThanOrEqual(400);
    expect((await action({ ...context, action: 'ABANDON' })).status).toBeGreaterThanOrEqual(400);
  }
  expect(await db.prisma.agentRun.findMany()).toEqual(before);
  expect(await h.read()).toEqual(delivery);
  expect(providers).toHaveLength(1);
  expect(providers[0]?.child.kill).not.toHaveBeenCalled();
  providers[0]?.response.resolve({ stopReason: 'end_turn' });
  await consumer.drain();
  expect((await h.read()).evidence?.outcome?.result).toBe('COMPLETED');
});

it('retries the same run through HTTP and rejects the unchanged earlier target without stopping its replacement', async () => {
  await recoveryWorktree();
  await launch();
  providers[0]?.response.resolve({ stopReason: 'end_turn' });
  await consumer.drain();
  await strictStop();
  const captured = (await target()).body.result.data.json;
  const initialOutcome = (await h.read()).evidence?.outcome;
  const before = await db.prisma.agentRun.update({
    where: { id: scope.runId },
    data: { attemptCount: 4 },
  });
  const submitted = { agentId: scope.agentId, ...captured.context };
  const response = await action({ ...submitted, action: 'RETRY' });
  expect(response.status).toBe(200);
  const result = response.body.result.data.json;
  expect(result.status).toBe('RETRIED');
  expect(result.claim).toEqual({ ...h.claim, attemptGeneration: 2 });
  expect((await h.read()).evidence?.resolution?.outcome).toEqual(initialOutcome);
  expect(result.attempt.messageId).not.toBe(h.attempt.messageId);
  expect(result.attempt.sendAttemptId).not.toBe(h.attempt.sendAttemptId);
  await vi.waitFor(() => expect(providers).toHaveLength(2));
  await providers[1]?.called;
  const after = await db.prisma.agentRun.findUniqueOrThrow({ where: { id: scope.runId } });
  for (const key of [
    'id',
    'reservedWorkspaceId',
    'reservedSessionId',
    'initialMessageId',
    'effectiveExecution',
    'attemptCount',
    'startedAt',
    'expiresAt',
  ] as const) {
    expect(after[key]).toEqual(before[key]);
  }
  expect(after.status).toBe('RUNNING');
  expect((await inspect(submitted)).status).toBe(409);
  expect((await action({ ...submitted, action: 'ABANDON' })).status).toBe(409);
  expect(providers[1]?.child.kill).not.toHaveBeenCalled();
  const current = (await target()).body.result.data.json;
  expect(current.context.claim.initialMessageId).toBe(h.claim.initialMessageId);
  expect(current.context.attempt.messageId).toBe(result.attempt.messageId);
  expect(current.context.attempt.messageId).not.toBe(current.context.claim.initialMessageId);
});

it.each(['RESOLVE', 'ABANDON'] as const)(
  'allows %s through HTTP when retry resources alone are missing',
  async (recoveryAction) => {
    await launch();
    providers[0]?.response.resolve({ stopReason: 'end_turn' });
    await consumer.drain();
    await strictStop();
    await db.prisma.workspace.update({
      where: { id: h.claim.reservedWorkspaceId },
      data: { worktreePath: `${db.tempDir}/missing` },
    });
    const input = fullInput();
    const inspection = await inspect(input);
    expect(inspection.status).toBe(200);
    expect(inspection.body.result.data.json).toMatchObject({
      blocked: null,
      retryBlocked: 'RESOURCES_UNAVAILABLE',
      retryResourcesAvailable: false,
      delivery: 'REACHED_OR_UNCERTAIN',
    });
    expect((await action({ ...input, action: 'RETRY' })).body.result.data.json).toEqual({
      status: 'BLOCKED',
      reason: 'RESOURCES_UNAVAILABLE',
    });
    expect((await action({ ...input, action: recoveryAction })).body.result.data.json.status).toBe(
      recoveryAction === 'RESOLVE' ? 'RESOLVED' : 'ABANDONED'
    );
    expect(providers).toHaveLength(1);
  }
);

it('fails closed when the application runtime has no recovery consumer', async () => {
  services.agentRuntime.recovery = undefined;
  const response = await action({ ...fullInput(), action: 'ABANDON' });
  expect(response.status).toBe(412);
  expect(response.body.error.json.message).toBe('Event recovery is unavailable.');
  expect(providers).toHaveLength(0);
});

it.each([
  { untrusted: 'remote', withOrigin: false },
  { untrusted: 'origin', withOrigin: true },
  ...FORWARDED_CLIENT_ADDRESS_HEADERS.flatMap((untrusted) => [
    { untrusted, withOrigin: false },
    { untrusted, withOrigin: true },
  ]),
])(
  'rejects $untrusted at the real HTTP boundary (Origin=$withOrigin) with no recovery effects',
  async ({ untrusted, withOrigin }) => {
    await launch();
    const before = await db.prisma.agentRun.findMany();
    const delivery = await h.read();
    for (const name of ['recoveryTarget', 'inspectRun', 'resolveAmbiguousRun']) {
      const input =
        name === 'recoveryTarget'
          ? scope
          : { ...fullInput(), ...(name === 'resolveAmbiguousRun' ? { action: 'ABANDON' } : {}) };
      const server = app(untrusted === 'remote');
      const sending =
        name === 'resolveAmbiguousRun'
          ? request(server).post(`/api/trpc/${name}`).send({ json: input })
          : request(server)
              .get(`/api/trpc/${name}`)
              .query({ input: JSON.stringify({ json: input }) });
      if (untrusted === 'origin') {
        sending.set('origin', 'https://evil.example');
      } else if (untrusted !== 'remote') {
        sending.set(untrusted, '203.0.113.10');
        if (withOrigin) {
          sending.set('origin', 'http://localhost:3000');
        }
      }
      expect((await sending).status).toBe(403);
    }
    expect(await db.prisma.agentRun.findMany()).toEqual(before);
    expect(await h.read()).toEqual(delivery);
    expect(providers).toHaveLength(1);
    expect(providers[0]?.child.kill).not.toHaveBeenCalled();
  }
);

it('allows the configured browser Origin to inspect and abandon the actual local run', async () => {
  await launch();
  providers[0]?.response.resolve({ stopReason: 'end_turn' });
  await consumer.drain();
  await strictStop();
  const input = fullInput();
  expect((await inspect(input).set('origin', 'http://localhost:3000')).status).toBe(200);
  const response = await action({ ...input, action: 'ABANDON' }).set(
    'origin',
    'http://localhost:3000'
  );
  expect(response.status).toBe(200);
  expect(response.body.result.data.json).toEqual({ status: 'ABANDONED' });
  expect((await db.prisma.agentRun.findUniqueOrThrow({ where: { id: scope.runId } })).status).toBe(
    'CANCELLED'
  );
});

it.each(['account', 'session'] as const)(
  'keeps missing %s resources as a retry-only limitation when proof remains supported',
  async (resource) => {
    await launch();
    providers[0]?.response.resolve({ stopReason: 'end_turn' });
    await consumer.drain();
    await strictStop();
    if (resource === 'account') {
      await db.prisma.codexAccount.update({
        where: { id: 'event-test-account' },
        data: { enabled: false },
      });
    } else {
      await db.prisma.agentSession.delete({ where: { id: h.attempt.sessionId } });
    }
    const inspected = await inspect(fullInput());
    expect(inspected.status).toBe(200);
    expect(inspected.body.result.data.json).toMatchObject({
      retryResourcesAvailable: false,
      retryBlocked: 'RESOURCES_UNAVAILABLE',
    });
    expect((await action({ ...fullInput(), action: 'RETRY' })).body.result.data.json).toEqual({
      status: 'BLOCKED',
      reason: 'RESOURCES_UNAVAILABLE',
    });
    if (resource === 'account') {
      expect((await action({ ...fullInput(), action: 'ABANDON' })).body.result.data.json).toEqual({
        status: 'ABANDONED',
      });
    }
    expect(providers).toHaveLength(1);
  }
);

it.each(['preparation', 'child', 'source', 'work'] as const)(
  'retains the existing %s hold through the public action',
  async (hold) => {
    if (hold === 'preparation') {
      await h.owner.eventRunLaunch.preparation(h.claim, 'SETUP');
    } else if (hold !== 'source') {
      await launch();
      providers[0]?.response.resolve({ stopReason: 'end_turn' });
      await consumer.drain();
      await strictStop();
      if (hold === 'child') {
        await h.creation.create({
          type: 'CHILD_WORKSPACE',
          projectId: scope.projectId,
          parentWorkspaceId: h.claim.reservedWorkspaceId,
          name: 'Unproven child',
        });
      } else {
        providers[0]?.update({
          sessionUpdate: 'session_info_update',
          _meta: { jetbrains: { air: { goal: { status: 'active' } } } },
        });
      }
    }
    if (hold === 'preparation' || hold === 'source') {
      await consumer.consumeClaim(h.claim, new AbortController().signal, true);
      await consumer.drain();
    }
    const before = await db.prisma.agentRun.findUniqueOrThrow({ where: { id: scope.runId } });
    const response = await action({ ...fullInput(), action: 'ABANDON' });
    expect(response.status).toBe(200);
    expect(response.body.result.data.json).toEqual({
      status: 'BLOCKED',
      reason: {
        preparation: 'PREPARATION_CLEANUP_UNCERTAIN',
        child: 'CHILD_WORK_UNPROVEN',
        source: 'SOURCE_UNAVAILABLE',
        work: 'WORK_PROOF_UNAVAILABLE',
      }[hold],
    });
    expect(await db.prisma.agentRun.findUniqueOrThrow({ where: { id: scope.runId } })).toEqual(
      before
    );
  }
);

it('does not turn retained provenance for a removed run into a target', async () => {
  await db.prisma.agentEvaluation.updateMany({
    where: { runId: scope.runId },
    data: { runId: null },
  });
  await db.prisma.agentRun.delete({ where: { id: scope.runId } });
  expect(
    await db.prisma.workspaceLaunchOrigin.findUnique({ where: { runId: scope.runId } })
  ).not.toBeNull();
  expect((await target()).body.result.data.json).toEqual({
    ...scope,
    status: 'UNAVAILABLE',
    reason: 'NOT_FOUND',
  });
});

it('never exposes internal owner failures through target, inspection or action', async () => {
  const transaction = db.prisma.$transaction.bind(db.prisma);
  vi.spyOn(db.prisma, '$transaction').mockImplementation((operation) =>
    transaction((tx) => {
      vi.spyOn(tx.agentRun, 'findFirst').mockRejectedValue(new Error('secret provider blob'));
      return operation(tx);
    })
  );
  for (const response of [
    await target(),
    await inspect(fullInput()),
    await action({ ...fullInput(), action: 'ABANDON' }),
  ]) {
    expect(response.status).toBe(412);
    expect(response.body.error.json.message).toBe('Event recovery target is unavailable.');
    expect(JSON.stringify(response.body)).not.toContain('secret provider blob');
  }
});

it('bounds internal consumer errors without exposing owner evidence or changing delivery', async () => {
  const before = await h.read();
  vi.spyOn(h.owner.eventRunRecovery, 'inspect').mockRejectedValue(
    new Error('private native source blob')
  );
  for (const response of [
    await inspect(fullInput()),
    await action({ ...fullInput(), action: 'ABANDON' }),
  ]) {
    expect(response.status).toBe(409);
    expect(response.body.error.json.message).toBe(
      'Event recovery context is unavailable or changed.'
    );
    expect(JSON.stringify(response.body)).not.toContain('private native source blob');
  }
  expect(await h.read()).toEqual(before);
  expect(providers).toHaveLength(0);
});
