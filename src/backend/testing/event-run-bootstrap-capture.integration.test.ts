import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Application, disposeApplication } from '@/backend/app-context';
import { createEventAdmissionSeed } from '@/backend/orchestration/testing/event-delivery.test-support';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from './integration-db';

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

let db: IntegrationDatabase;
let application: Application;
let dispose: typeof disposeApplication;
let seed: Awaited<ReturnType<typeof createEventAdmissionSeed>>;
let claim: Extract<Awaited<ReturnType<typeof seed.owner.claimNextRun>>, { status: 'CLAIMED' }>;
beforeEach(async () => {
  db = await createIntegrationDatabase();
  const runScript = await vi.importActual<typeof import('@/backend/services/run-script')>(
    '@/backend/services/run-script'
  );
  vi.spyOn(runScript.RunScriptService.prototype, 'registerShutdownHandlers').mockImplementation(
    () => undefined
  );
  const factory = await vi.importActual<
    typeof import('@/backend/services/session/service/acp/acp-client-factory')
  >('@/backend/services/session/service/acp/acp-client-factory');
  vi.spyOn(factory.AcpClientFactory.prototype, 'createClient').mockImplementation(() => {
    throw new Error('Unexpected provider creation');
  });
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw new Error('Unexpected host signal');
  });
  const app =
    await vi.importActual<typeof import('@/backend/app-context')>('@/backend/app-context');
  dispose = app.disposeApplication;
  const dependencies = app.createDefaultApplicationDependencies();
  vi.spyOn(dependencies.lifecycle.eventCollector, 'start').mockImplementation(() => undefined);
  application = app.createApplication(dependencies);
  seed = await createEventAdmissionSeed(db, 'CLAUDE');
  const claimed = await seed.owner.claimNextRun();
  if (claimed.status !== 'CLAIMED') {
    throw new Error('Fixture did not claim');
  }
  claim = claimed;
  const binding = await seed.owner.readEventExecutionBinding(claim);
  await seed.owner.freezeEventExecution({ claim, ...binding, execution: seed.execution });
  await application.services.workspaceCreationService.createEventWorkspaceOnce({
    type: 'EVENT_AGENT',
    runId: claim.runId,
    projectId: seed.project.id,
    reservedWorkspaceId: claim.reservedWorkspaceId,
    reservedSessionId: claim.reservedSessionId,
    initialMessageId: claim.initialMessageId,
    name: 'Bootstrap capture',
    execution: seed.execution,
    input: seed.input,
  });
  await application.services.sessionDataService.createEventSessionOnce({
    id: claim.reservedSessionId,
    workspaceId: claim.reservedWorkspaceId,
    runId: claim.runId,
    execution: seed.execution,
  });
  await seed.owner.eventRunLaunch.link(claim);
  const attempt = {
    runId: claim.runId,
    sessionId: claim.reservedSessionId,
    workerGeneration: claim.workerGeneration,
    attemptGeneration: claim.attemptGeneration,
    messageId: binding.messageId,
    sendAttemptId: binding.sendAttemptId,
  };
  const source = {
    version: 1 as const,
    provider: seed.execution.provider,
    providerSessionId: 'bootstrap-native',
    runtimeIncarnationId: 'bootstrap-runtime',
    lifecycleGeneration: 1,
  };
  await seed.owner.agentInitialDelivery.beforeSend(attempt, source);
  await seed.owner.agentInitialDelivery.outcome(attempt, {
    source,
    stopReason: 'end_turn',
    result: 'COMPLETED',
  });
  const prs = application.services.workspacePrSnapshotService;
  const detached = await prs.attach(
    claim.reservedWorkspaceId,
    'https://github.com/org/repo/PULL/42'
  );
  expect(await prs.detach({ workspaceId: claim.reservedWorkspaceId, prId: detached.prId })).toEqual(
    { removed: true, dispatchReleased: false }
  );
  await prs.attach(claim.reservedWorkspaceId, 'https://github.com/org/repo/pull/43');
}, 30_000);
afterEach(async () => {
  try {
    if (application) {
      await dispose(application);
    }
    expect(process.kill).not.toHaveBeenCalled();
    const factory = await vi.importActual<
      typeof import('@/backend/services/session/service/acp/acp-client-factory')
    >('@/backend/services/session/service/acp/acp-client-factory');
    expect(factory.AcpClientFactory.prototype.createClient).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    await destroyIntegrationDatabase(db);
  }
});
async function snapshot() {
  return {
    run: await db.prisma.agentRun.findUniqueOrThrow({ where: { id: claim.runId } }),
    delivery: await db.prisma.agentInitialDelivery.findUniqueOrThrow({
      where: { runId: claim.runId },
    }),
    workspace: await db.prisma.workspace.findUnique({ where: { id: claim.reservedWorkspaceId } }),
    prs: await db.prisma.workspacePR.findMany({
      where: { workspaceId: claim.reservedWorkspaceId },
      orderBy: { id: 'asc' },
    }),
    sessions: await db.prisma.agentSession.findMany(),
    workspaceOrigins: await db.prisma.workspaceLaunchOrigin.findMany(),
    sessionOrigins: await db.prisma.agentSessionLaunchOrigin.findMany(),
    accounts: await db.prisma.codexAccount.findMany(),
  };
}
it('captures unseen attached and retained detached PRs through fresh production application deletion', async () => {
  const before = await snapshot();
  expect(before.run.status).toBe('RUNNING');
  expect(before.delivery.state).toBe('FINISHED');
  expect(before.run.result).toBeNull();
  expect(before.prs).toHaveLength(2);
  expect(before.prs.every((pr) => pr.number === null && pr.syncedAt === null)).toBe(true);
  expect(before.prs.filter((pr) => pr.detachedAt !== null)).toHaveLength(1);
  await application.services.workspaceDataService.delete(claim.reservedWorkspaceId);
  const after = await snapshot();
  const result = seed.owner.agentRunResultSchema.parse(after.run.result);
  expect(result).toEqual({
    version: 1,
    summary: '',
    pullRequests: expect.arrayContaining([
      { url: 'https://github.com/org/repo/PULL/42', number: 42 },
      { url: 'https://github.com/org/repo/pull/43', number: 43 },
    ]),
  });
  expect(result.pullRequests).toHaveLength(2);
  expect(after).toEqual({
    ...before,
    workspace: null,
    prs: [],
    sessions: [],
    run: { ...before.run, workspaceId: null, result },
  });
});
it.each(['capture', 'cascade', 'tuple'] as const)(
  'rolls back production deletion on %s failure in the same graph',
  async (failure) => {
    if (failure === 'tuple') {
      await db.prisma.agentInitialDelivery.update({
        where: { runId: claim.runId },
        data: { attemptGeneration: 2 },
      });
    } else {
      const transaction = db.prisma.$transaction.bind(db.prisma);
      vi.spyOn(db.prisma, '$transaction').mockImplementationOnce((operation) =>
        transaction((tx) => {
          if (failure === 'capture') {
            vi.spyOn(tx.agentRun, 'updateMany').mockRejectedValueOnce(new Error('capture failed'));
          } else {
            vi.spyOn(tx.workspace, 'delete').mockRejectedValueOnce(new Error('cascade failed'));
          }
          return operation(tx);
        })
      );
    }
    const before = await snapshot();
    await expect(
      application.services.workspaceDataService.delete(claim.reservedWorkspaceId)
    ).rejects.toThrow(
      failure === 'tuple' ? 'Event launch ownership is no longer current' : `${failure} failed`
    );
    expect(await snapshot()).toEqual(before);
  }
);
