import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { isProcessRunning } from '@/backend/lib/process-liveness';
import { runScriptStateMachine } from '@/backend/services/run-script';
import {
  sessionDataService,
  sessionLifecycleService,
  sessionRepository,
} from '@/backend/services/session';
import { terminalSessionService, terminalService } from '@/backend/services/terminal';
import {
  workspaceRunScriptService,
  workspacePRMonitoringService,
  workspaceMaintenanceService,
  workspacePrSnapshotService,
  worktreeLifecycleService,
} from '@/backend/services/workspace';
import {
  clearIntegrationDatabase,
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import type { PRDeliveryRequest } from '@/shared/pr-monitoring';
import { redObservation } from '@/shared/pr-monitoring.test-helpers';
import { exportDataSchema } from '@/shared/schemas/export-data.schema';
import type { PrismaClient } from '@prisma-gen/client';
import { dataBackupService } from './data-backup.service';
import { defaultPRDeliveryPorts } from './pr-delivery-dependencies';
import { recoverPRDeliveries } from './pr-delivery-recovery';
import { preparePRDelivery, wakePRDelivery } from './pr-event-delivery.orchestrator';
import type { PRDeliveryPorts } from './pr-monitoring-ports';
import { reconciliationService } from './reconciliation.service';
import {
  recoverStaleArchivingWorkspaces,
  type ArchiveWorkspaceDependencies,
} from './workspace-archive.orchestrator';
import * as workspaceChildren from './workspace-children.orchestrator';

const database = vi.hoisted(() => ({
  prisma: undefined as PrismaClient | undefined,
  forbiddenEffects: [] as string[],
}));
vi.mock(
  '@/backend/services/run-script/service/run-script-process-utils',
  async (importOriginal) => {
    const forbidden = () => {
      database.forbiddenEffects.push('shell process');
      throw new Error('Forbidden imported process action');
    };
    return {
      ...(await importOriginal<Record<string, unknown>>()),
      spawnPipedShellCommand: forbidden,
      treeKillProcess: forbidden,
      runCleanupScriptProcess: forbidden,
    };
  }
);
vi.mock('@/backend/db', () => ({
  get prisma() {
    return database.prisma;
  },
}));
vi.mock('@/backend/lib/process-liveness', () => ({ isProcessRunning: vi.fn(async () => true) }));
let db: IntegrationDatabase;
const old = new Date('2020-01-01T00:00:00.000Z');
beforeAll(async () => {
  db = await createIntegrationDatabase();
  database.prisma = db.prisma;
}, 30_000);
afterAll(async () => destroyIntegrationDatabase(db));
afterEach(() => vi.restoreAllMocks());
beforeEach(async () => {
  database.forbiddenEffects.length = 0;
  await clearIntegrationDatabase(db.prisma);
  await db.prisma.project.create({
    data: { id: 'p', name: 'P', slug: 'p', repoPath: '/tmp/p', worktreeBasePath: '/tmp/w' },
  });
  for (const status of ['READY', 'NEW', 'PROVISIONING', 'ARCHIVING'] as const) {
    await db.prisma.workspace.create({
      data: {
        id: status,
        projectId: 'p',
        name: status,
        status,
        worktreePath: db.tempDir,
        initErrorMessage: 'original error',
        initOutput: 'retained output',
        initStartedAt: old,
        updatedAt: old,
        runScript: { create: {} },
      },
    });
  }
  await workspaceRunScriptService.setCommands('READY', {
    runScriptCommand: 'pnpm dev',
    runScriptCleanupCommand: 'cleanup authored',
    runScriptPostRunCommand: null,
  });
  await workspaceRunScriptService.transitionStatusIfCurrent('READY', 'IDLE', {
    runScriptStatus: 'RUNNING',
    runScriptPid: 765_432,
    runScriptPort: 4321,
    runScriptStartedAt: old,
  });
  await terminalSessionService.registerSession({
    workspaceId: 'READY',
    name: 'authored terminal',
    pid: 765_433,
  });
  await db.prisma.terminalSession.updateMany({ data: { status: 'RUNNING' } });
  await db.prisma.agentSession.create({
    data: {
      id: 'main',
      workspaceId: 'READY',
      workflow: 'implement',
      status: 'RUNNING',
      provider: 'CLAUDE',
      providerSessionId: 'provider-history',
      providerProjectPath: '/old/project',
      providerProcessPid: 765_434,
      model: 'default',
    },
  });
  await workspacePRMonitoringService.setBinding({
    workspaceId: 'READY',
    recipientSessionId: 'main',
    enabled: true,
    expectedBindingRevision: 0,
  });
});

it.each([4, 5, 6, 7, 8])(
  'imports version %s runtime authority inertly and reports only created changes',
  async (schemaVersion) => {
    const exported = await dataBackupService.exportData('test');
    const backup = exportDataSchema.parse({
      ...exported,
      meta: { ...exported.meta, schemaVersion },
      data: {
        ...exported.data,
        codexAccounts: schemaVersion >= 7 ? exported.data.codexAccounts : undefined,
        agentSessions: exported.data.agentSessions.map((session) => ({
          ...session,
          codexAccountId: schemaVersion >= 7 ? session.codexAccountId : undefined,
        })),
        workspaces: exported.data.workspaces.map((workspace) => ({
          ...workspace,
          prs: schemaVersion === 4 ? undefined : workspace.prs,
          prMonitoring: schemaVersion <= 5 ? undefined : workspace.prMonitoring,
          prEvents: schemaVersion <= 5 ? undefined : workspace.prEvents,
          ratchetActivePrId: null,
        })),
      },
    });
    await clearIntegrationDatabase(db.prisma);
    const result = await dataBackupService.importData(backup);
    expect(
      await db.prisma.workspaceRunScript.findUnique({ where: { workspaceId: 'READY' } })
    ).toMatchObject({
      command: 'pnpm dev',
      cleanupCommand: 'cleanup authored',
      status: 'IDLE',
      pid: null,
      port: null,
      startedAt: null,
    });
    expect(await db.prisma.terminalSession.findFirst()).toMatchObject({
      name: 'authored terminal',
      status: 'IDLE',
      pid: null,
    });
    expect(await db.prisma.agentSession.findUnique({ where: { id: 'main' } })).toMatchObject({
      status: 'IDLE',
      providerProcessPid: null,
      providerSessionId: 'provider-history',
      providerProjectPath: '/old/project',
    });
    for (const status of ['NEW', 'PROVISIONING', 'ARCHIVING']) {
      const workspace = await db.prisma.workspace.findUniqueOrThrow({ where: { id: status } });
      expect(workspace).toMatchObject({
        status: 'FAILED',
        initStartedAt: null,
        initScriptPid: null,
        initOutput: 'retained output',
      });
      expect(workspace.initErrorMessage).toContain('original error');
      expect(workspace.initErrorMessage).toContain(status);
      expect(workspace.initErrorMessage).toMatch(/manual/i);
    }
    expect(await workspacePRMonitoringService.get('READY')).toMatchObject({ enabled: false });
    expect(result).toMatchObject({
      inertTransforms: {
        workspaceWorkflows: 3,
        workspaceInitializations: 2,
        workspaceArchives: 1,
        runScripts: 1,
        terminalSessions: 1,
        agentSessions: 1,
        monitors: 1,
        heldReceipts: 0,
        cancelledFacts: 0,
      },
    });
    const before = await dataBackupService.exportData('test');
    const repeated = await dataBackupService.importData(backup);
    expect(repeated).toMatchObject({
      inertTransforms: {
        workspaceWorkflows: 0,
        runScripts: 0,
        terminalSessions: 0,
        agentSessions: 0,
        monitors: 0,
        heldReceipts: 0,
        cancelledFacts: 0,
      },
    });
    expect((await dataBackupService.exportData('test')).data).toEqual(before.data);
  }
);

it('leaves colliding local runtime owners untouched and reports no transformations', async () => {
  const backup = await dataBackupService.exportData('test');
  const before = backup.data;
  const result = await dataBackupService.importData(backup);
  expect((await dataBackupService.exportData('test')).data).toMatchObject({
    workspaces: before.workspaces,
    agentSessions: before.agentSessions,
    terminalSessions: before.terminalSessions,
  });
  expect(result).toMatchObject({
    inertTransforms: {
      workspaceWorkflows: 0,
      runScripts: 0,
      terminalSessions: 0,
      agentSessions: 0,
      monitors: 0,
      heldReceipts: 0,
      cancelledFacts: 0,
    },
  });
});

it.each([
  ['MAIN', false],
  ['MAIN', true],
  ['DEDICATED', false],
  ['DEDICATED', true],
] as const)(
  'holds %s imported receipt evidence (pending: %s) before normalization and cancels only unclaimed facts',
  async (deliveryMode, pending) => {
    await db.prisma.workspacePR.create({
      data: { id: 'pr', workspaceId: 'READY', url: redObservation.url },
    });
    if (deliveryMode === 'DEDICATED') {
      await workspacePRMonitoringService.setBinding({
        workspaceId: 'READY',
        deliveryMode,
        enabled: true,
        expectedBindingRevision: 1,
      });
      await db.prisma.agentSession.update({
        where: { id: 'main' },
        data: { workflow: 'pr-monitoring', workspacePrId: 'pr' },
      });
      await db.prisma.workspacePRDedicatedSession.create({
        data: { prId: 'pr', sessionId: 'main' },
      });
    }
    const config = await workspacePRMonitoringService.get('READY');
    const request = {
      workspaceId: 'READY',
      prId: deliveryMode === 'MAIN' ? null : 'pr',
      deliveryMode,
      bindingRevision: config!.bindingRevision,
    };
    let hasMergeConflict = false;
    const insert = async (keys: string[]) => {
      hasMergeConflict ||= keys.length > 1;
      const target = { workspaceId: 'READY', prId: 'pr' };
      const pr = await workspacePrSnapshotService.find(target);
      const result = await workspacePrSnapshotService.acceptMonitoredObservation({
        target,
        expectedPrRevision: pr!.revision,
        expectedEventEpoch: config!.eventEpoch,
        observation: { ...redObservation, headSha: keys.join('-'), hasMergeConflict },
      });
      expect(result.applied).toBe(true);
      expect(result.eventIds).toHaveLength(keys.length);
      return result.eventIds;
    };
    const settledIds = await insert(['settled']);
    const settled = await workspacePRMonitoringService.claimDelivery(request, {
      deliveryId: 'settled',
      sessionId: 'main',
      eventIds: settledIds,
      text: 'settled exact 🐟 bytes',
    });
    expect(settled).not.toBeNull();
    await workspacePRMonitoringService.recoverClaim('settled', true);
    const frozenIds = await insert(['frozen-a', 'frozen-b']);
    expect(
      await workspacePRMonitoringService.claimDelivery(request, {
        deliveryId: 'uncertain',
        sessionId: 'main',
        eventIds: frozenIds,
        text: 'uncertain exact 🐟 bytes\nsecond line',
      })
    ).not.toBeNull();
    if (pending) {
      await workspacePRMonitoringService.recoverClaim('uncertain', false);
    }
    const unclaimed = await insert(['unclaimed']);
    const backup = await dataBackupService.exportData('test');
    const sourceEvents = backup.data.workspaces.find((row) => row.id === 'READY')!.prEvents;
    await clearIntegrationDatabase(db.prisma);
    const result = await dataBackupService.importData(backup);
    expect(
      await db.prisma.workspacePRDelivery.findUnique({ where: { id: 'uncertain' } })
    ).toMatchObject({ state: 'BLOCKED', eventIds: frozenIds });
    const reexport = await dataBackupService.exportData('test');
    const restoredEvents = reexport.data.workspaces.find((row) => row.id === 'READY')!.prEvents;
    for (const source of sourceEvents.filter((row) => row.deliveryId)) {
      expect(restoredEvents.find((row) => row.id === source.id)).toEqual(source);
    }
    expect(
      await db.prisma.workspacePREvent.findUnique({ where: { id: unclaimed[0] } })
    ).toMatchObject({ state: 'CANCELLED', deliveredAt: null });
    expect(result).toMatchObject({
      inertTransforms: { monitors: 1, heldReceipts: 1, cancelledFacts: 1 },
    });
    expect(await workspacePRMonitoringService.get('READY')).toMatchObject({
      enabled: false,
      deliveryMode,
    });
    for (const delivered of [false, true]) {
      await workspacePRMonitoringService.recoverClaim('uncertain', delivered);
      await workspacePRMonitoringService.cancelRecoveredDelivery('uncertain', 'main');
      expect(
        await db.prisma.workspacePRDelivery.findUnique({ where: { id: 'uncertain' } })
      ).toMatchObject({ state: 'BLOCKED', deliveredAt: null });
    }
    const importedConfig = await workspacePRMonitoringService.get('READY');
    await workspacePRMonitoringService.setBinding({
      workspaceId: 'READY',
      enabled: true,
      resume: true,
      expectedBindingRevision: importedConfig!.bindingRevision,
    });
    let enabled = await workspacePRMonitoringService.get('READY');
    expect(
      await workspacePRMonitoringService.claimDelivery(
        { ...request, bindingRevision: enabled!.bindingRevision },
        {
          deliveryId: 'uncertain',
          sessionId: 'main',
          eventIds: frozenIds,
          text: 'uncertain exact 🐟 bytes\nsecond line',
        }
      )
    ).toBeNull();
    expect(enabled).toMatchObject({ enabled: true, deliveryMode });
    expect(await sessionDataService.findAgentSessionById('main')).toMatchObject({
      workspace: { status: 'READY' },
    });
    const providerSend = vi.fn();
    const queued = new Map<string, PRDeliveryRequest>();
    const drains: Promise<void>[] = [];
    const findReceipt = vi.fn<typeof defaultPRDeliveryPorts.findPRDeliveryReceipt>(
      async () => 'absent'
    );
    const ports: PRDeliveryPorts = {
      ...defaultPRDeliveryPorts,
      sessionDataService,
      workspacePRMonitoringService,
      acpRuntimeManager: {
        ...defaultPRDeliveryPorts.acpRuntimeManager,
        isSessionPromptInFlight: () => false,
      },
      sessionBackgroundDeliveryService: {
        ...defaultPRDeliveryPorts.sessionBackgroundDeliveryService,
        isDeliveryActive: () => false,
      },
      sessionDomainService: { getPendingInteractiveRequest: () => null },
      backgroundDispatch: {
        ...defaultPRDeliveryPorts.backgroundDispatch,
        enqueue: (sessionId, request) => {
          queued.set(sessionId, request);
          return { queued: true };
        },
        wakeSession: (sessionId) => {
          const drain = (async () => {
            const request = queued.get(sessionId);
            if (
              request &&
              (await preparePRDelivery({ sessionId, request }, ports)).status === 'ready'
            ) {
              providerSend();
            }
          })();
          drains.push(drain);
          return drain;
        },
      },
      sessionLifecycleService: {
        startSession: () => {
          throw new Error('Imported receipt must not start a runtime');
        },
      },
      findPRDeliveryReceipt: findReceipt,
    };
    for (const receipt of ['absent', 'delivered'] as const) {
      findReceipt.mockResolvedValue(receipt);
      await recoverPRDeliveries('main', 'READY', ports);
      await workspacePRMonitoringService.resume('main');
      enabled = await workspacePRMonitoringService.get('READY');
      expect(enabled).toMatchObject({ enabled: true, deliveryPauseReason: null });
      expect(
        await preparePRDelivery(
          {
            sessionId: 'main',
            request: { ...request, prId: 'pr', bindingRevision: enabled!.bindingRevision },
          },
          ports
        )
      ).toMatchObject({ status: 'blocked' });
      expect(
        await db.prisma.workspacePRDelivery.findUnique({ where: { id: 'uncertain' } })
      ).toMatchObject({ state: 'BLOCKED', deliveredAt: null });
      await wakePRDelivery('READY', ports);
      await Promise.all(drains);
    }
    await db.prisma.agentSession.create({
      data: {
        id: 'replacement',
        workspaceId: 'READY',
        workflow: 'implement',
        provider: 'CLAUDE',
        providerSessionId: 'new-provider',
      },
    });
    enabled = await workspacePRMonitoringService.get('READY');
    await workspacePRMonitoringService.setBinding({
      workspaceId: 'READY',
      deliveryMode: 'MAIN',
      recipientSessionId: 'replacement',
      enabled: true,
      resume: true,
      expectedBindingRevision: enabled!.bindingRevision,
    });
    await db.prisma.$disconnect();
    await db.prisma.$connect();
    await recoverPRDeliveries('main', 'READY', ports);
    await workspacePRMonitoringService.resume('replacement');
    const rebound = await workspacePRMonitoringService.get('READY');
    expect(
      await preparePRDelivery(
        {
          sessionId: 'replacement',
          request: { workspaceId: 'READY', prId: 'pr', bindingRevision: rebound!.bindingRevision },
        },
        ports
      )
    ).toMatchObject({ status: 'blocked' });
    await wakePRDelivery('READY', ports);
    await Promise.all(drains);
    expect(findReceipt).toHaveBeenCalled();
    expect(providerSend).not.toHaveBeenCalled();
    expect(
      await db.prisma.workspacePRDelivery.findUnique({ where: { id: 'uncertain' } })
    ).toMatchObject({ state: 'BLOCKED', deliveredAt: null });
  }
);

it('keeps actual startup and idle consumers away from imported process and workflow effects', async () => {
  const effects: string[] = [];
  const forbidden = () => {
    effects.push('unexpected effect');
    throw new Error('Forbidden imported runtime effect');
  };
  vi.spyOn(process, 'kill').mockImplementation(forbidden);
  vi.mocked(isProcessRunning).mockImplementation(() => {
    effects.push('process probe');
    return Promise.resolve(true);
  });
  vi.spyOn(terminalService, 'createTerminal').mockImplementation(forbidden);
  vi.spyOn(terminalService, 'destroyWorkspaceTerminals').mockImplementation(forbidden);
  vi.spyOn(sessionLifecycleService, 'startSession').mockImplementation(forbidden);
  vi.spyOn(worktreeLifecycleService, 'cleanupWorkspaceWorktree').mockImplementation(forbidden);
  vi.spyOn(workspaceChildren, 'fireLifecycleNotification').mockImplementation(forbidden);
  vi.spyOn(terminalService, 'destroyTerminal').mockImplementation(forbidden);
  const archive: ArchiveWorkspaceDependencies = {
    cleanupWorkspaceScopedCaches: forbidden,
    githubCLIService: { addIssueComment: forbidden },
    runScriptService: { stopRunScript: forbidden, evictWorkspaceBuffers: forbidden },
    sessionLifecycleService: { stopWorkspaceSessions: forbidden },
    terminalService: { destroyWorkspaceTerminals: forbidden },
  };
  const backup = await dataBackupService.exportData('test');
  await clearIntegrationDatabase(db.prisma);
  await dataBackupService.importData(backup);
  reconciliationService.configure({
    workspace: {
      findNeedingWorktree: () => workspaceMaintenanceService.findNeedingWorktree(),
      initializeWorktree: forbidden,
      recoverStaleProvisioningWorkspace: forbidden,
    },
    terminal: terminalSessionService,
  });
  for (let restart = 0; restart < 2; restart++) {
    await reconciliationService.reconcile();
    await reconciliationService.cleanupOrphans();
    expect(await sessionRepository.recoverStaleRunningSessions()).toBe(0);
    await runScriptStateMachine.recoverStaleStates();
    for (const row of backup.data.workspaces) {
      expect(await runScriptStateMachine.verifyRunning(row.id)).toBe('IDLE');
    }
    expect(await recoverStaleArchivingWorkspaces(archive)).toEqual({ archived: [], failed: [] });
    await db.prisma.$disconnect();
    await db.prisma.$connect();
  }
  expect(effects).toEqual([]);
  expect(database.forbiddenEffects).toEqual([]);
});

it('preserves settled process history and counts active or stale references once per created row', async () => {
  for (const status of ['STARTING', 'STOPPING', 'COMPLETED', 'FAILED', 'IDLE'] as const) {
    await db.prisma.workspace.create({
      data: {
        id: `script-${status}`,
        projectId: 'p',
        name: status,
        status: 'READY',
        runScript: { create: { status, pid: status === 'COMPLETED' ? 765_435 : null } },
      },
    });
  }
  await db.prisma.terminalSession.create({
    data: { workspaceId: 'READY', name: 'finished terminal', status: 'COMPLETED' },
  });
  await db.prisma.agentSession.create({
    data: {
      id: 'finished',
      workspaceId: 'READY',
      workflow: 'implement',
      provider: 'CLAUDE',
      status: 'COMPLETED',
    },
  });
  const backup = await dataBackupService.exportData('test');
  await clearIntegrationDatabase(db.prisma);
  const result = await dataBackupService.importData(backup);
  for (const [source, status] of [
    ['STARTING', 'IDLE'],
    ['STOPPING', 'IDLE'],
    ['COMPLETED', 'COMPLETED'],
    ['FAILED', 'FAILED'],
    ['IDLE', 'IDLE'],
  ]) {
    expect(
      await db.prisma.workspaceRunScript.findUnique({ where: { workspaceId: `script-${source}` } })
    ).toMatchObject({ status, pid: null, port: null, startedAt: null });
  }
  expect(await db.prisma.agentSession.findUnique({ where: { id: 'finished' } })).toMatchObject({
    status: 'COMPLETED',
  });
  expect(
    await db.prisma.terminalSession.findFirst({ where: { name: 'finished terminal' } })
  ).toMatchObject({ status: 'COMPLETED' });
  expect(result).toMatchObject({
    inertTransforms: { runScripts: 4, terminalSessions: 1, agentSessions: 1 },
  });
});

it('rolls back inert rows and produces no success result after a late owner restore failure', async () => {
  const backup = await dataBackupService.exportData('test');
  await clearIntegrationDatabase(db.prisma);
  vi.spyOn(workspacePRMonitoringService, 'restoreEventsBackup').mockRejectedValueOnce(
    new Error('late owner failure')
  );
  await expect(dataBackupService.importData(backup)).rejects.toThrow('late owner failure');
  expect(await db.prisma.workspace.count()).toBe(0);
  expect(await db.prisma.project.count()).toBe(0);
  expect(await db.prisma.agentSession.count()).toBe(0);
  expect(await db.prisma.terminalSession.count()).toBe(0);
  expect(await db.prisma.workspacePRMonitoring.count()).toBe(0);
});

it.each(['DELIVERED', 'CANCELLED', 'SUPERSEDED'] as const)(
  'retains settled %s receipt state and timestamps without reporting a hold',
  async (state) => {
    const ids = await workspacePRMonitoringService.addEnabledControl('READY', 1, false);
    expect(
      await workspacePRMonitoringService.claimDelivery(
        { workspaceId: 'READY', prId: null, bindingRevision: 1 },
        {
          deliveryId: 'settled-legacy',
          sessionId: 'main',
          eventIds: ids,
          text: 'retained historical receipt',
        }
      )
    ).not.toBeNull();
    await workspacePRMonitoringService.recoverClaim('settled-legacy', true);
    const backup = await dataBackupService.exportData('test');
    // Historical formats allow SUPERSEDED receipts; the current producer settles DELIVERED.
    for (const workspace of backup.data.workspaces) {
      workspace.prEvents = workspace.prEvents.map((event) => ({ ...event, state }));
    }
    await clearIntegrationDatabase(db.prisma);
    const result = await dataBackupService.importData(backup);
    expect(
      await db.prisma.workspacePRDelivery.findUnique({ where: { id: 'settled-legacy' } })
    ).toMatchObject({ state });
    const restored = await dataBackupService.exportData('test');
    expect(restored.data.workspaces.find((row) => row.id === 'READY')!.prEvents).toEqual(
      backup.data.workspaces.find((row) => row.id === 'READY')!.prEvents
    );
    expect(result.inertTransforms.heldReceipts).toBe(0);
  }
);

it('retains incomplete unbound frozen evidence without making it claimable or reporting a cancellation', async () => {
  const ids = await workspacePRMonitoringService.addEnabledControl('READY', 1, false);
  const backup = await dataBackupService.exportData('test');
  for (const workspace of backup.data.workspaces) {
    workspace.prEvents = workspace.prEvents.map((event) => ({
      ...event,
      deliveryText: 'partial historical evidence',
      claimedAt: old.toISOString(),
    }));
  }
  await clearIntegrationDatabase(db.prisma);
  const result = await dataBackupService.importData(backup);
  expect(result.inertTransforms.cancelledFacts).toBe(0);
  expect(await db.prisma.workspacePREvent.findUnique({ where: { id: ids[0] } })).toMatchObject({
    state: 'PENDING',
    deliveryId: null,
    deliveryText: 'partial historical evidence',
    claimedAt: old,
    deliveredAt: null,
  });
  const binding = await workspacePRMonitoringService.setBinding({
    workspaceId: 'READY',
    enabled: true,
    expectedBindingRevision: 1,
  });
  expect(binding).toEqual({ applied: true, bindingRevision: 2 });
  expect(await workspacePRMonitoringService.get('READY')).toMatchObject({
    enabled: true,
    bindingRevision: 2,
    deliveryMode: 'MAIN',
    recipientSessionId: 'main',
    deliveryPauseReason: null,
  });
  expect(
    await workspacePRMonitoringService.claimDelivery(
      { workspaceId: 'READY', prId: null, bindingRevision: binding.bindingRevision },
      { deliveryId: 'new', sessionId: 'main', eventIds: ids, text: 'replacement text' }
    )
  ).toBeNull();
});
