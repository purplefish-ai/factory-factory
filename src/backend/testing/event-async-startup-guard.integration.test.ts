import { expect, it, vi } from 'vitest';
import { boundary } from '@/backend/orchestration/testing/event-delivery.test-support';
import {
  db,
  h,
  providers,
  readyRetryPRFixture,
} from '@/test-utils/event-generic-retry.test-support';

it.each([
  ['startSession', false],
  ['startSession', true],
  ['getOrCreate', false],
  ['getOrCreate', true],
] as const)(
  'preserves dedicated PR bootstrap async-only options through %s recovered dispatch, revoked=%s',
  async (entry, revoked) => {
    const { workspace } = await readyRetryPRFixture();

    await db.prisma.workspacePRMonitoring.update({
      where: { workspaceId: workspace.id },
      data: { deliveryMode: 'DEDICATED', recipientSessionId: null },
    });
    const notice = await h.workspace.workspaceNotificationService.notifyParent({
      workspaceId: workspace.id,
      sourceWorkspaceId: 'source',
      sourceWorkspaceName: 'Source',
      sourceProjectName: 'Fixture',
      message: 'Recovered dedicated update',
    });
    const { createDefaultApplicationDependencies } =
      await vi.importActual<typeof import('@/backend/app-context')>('@/backend/app-context');
    const graph = createDefaultApplicationDependencies();
    graph.lifecycle.wireDomainBridges(graph.services);
    const { ensureDedicatedPRRecipient } = await vi.importActual<
      typeof import('@/backend/orchestration/pr-dedicated-session.orchestrator')
    >('@/backend/orchestration/pr-dedicated-session.orchestrator');
    const { createPRDeliveryPorts } = await vi.importActual<
      typeof import('@/backend/orchestration/pr-delivery-dependencies')
    >('@/backend/orchestration/pr-delivery-dependencies');
    const { SessionConfigService } = await vi.importActual<
      typeof import('@/backend/services/session/service/lifecycle/session.config.service')
    >('@/backend/services/session/service/lifecycle/session.config.service');
    const configure = SessionConfigService.prototype.configureQueuedMessage;
    const held = boundary();
    let targetId: string | undefined;
    let baselineConfig = 0;
    vi.spyOn(SessionConfigService.prototype, 'configureQueuedMessage').mockImplementation(
      async function (this: InstanceType<typeof SessionConfigService>, id, ...args) {
        targetId = id;
        baselineConfig = providers[2]!.connection.setSessionConfigOption.mock.calls.length;
        const wakeTimestamp = Date.parse(args[0].timestamp);
        expect(Number.isFinite(wakeTimestamp)).toBe(true);
        expect(wakeTimestamp).toBeGreaterThanOrEqual(notice.createdAt.getTime());
        await held.wait();
        return configure.call(this, id, ...args);
      }
    );
    if (entry === 'getOrCreate') {
      // Exercise the second public startup entry with the actual dedicated caller's
      // async-only options; production bootstrap itself uses startSession.
      vi.spyOn(h.session.sessionLifecycleService, 'startSession').mockImplementation(
        async (id, options) => {
          expect(options?.assertCurrent).toBeTypeOf('function');
          expect(options?.assertCurrentSync).toBeUndefined();
          await h.session.sessionLifecycleService.getOrCreateSessionClient(id, options);
        }
      );
    }
    const starting = ensureDedicatedPRRecipient(
      { workspaceId: workspace.id, prId: 'first', bindingRevision: 1 },
      createPRDeliveryPorts(graph.services),
      () => true
    );
    try {
      await held.entered;
      expect(targetId).toBeDefined();
      expect(await db.prisma.agentSession.findUnique({ where: { id: targetId! } })).toMatchObject({
        workspacePrId: 'first',
        workflow: 'pr-monitoring',
      });
      if (revoked) {
        expect(
          await h.workspace.workspacePRMonitoringService.pauseWorkspace(
            workspace.id,
            'USER_STOPPED',
            1
          )
        ).toMatchObject({ count: 1 });
      }
    } finally {
      held.release();
      providers[2]?.response.resolve({ stopReason: 'end_turn' });
    }
    const result = await starting;
    expect(providers[2]!.connection.prompt).toHaveBeenCalledTimes(revoked ? 0 : 1);
    if (revoked) {
      expect(providers[2]!.connection.setSessionConfigOption).toHaveBeenCalledTimes(baselineConfig);
      expect(result).toBeNull();
    } else {
      expect(result?.id).toBe(targetId);
      const prompt = JSON.stringify(providers[2]!.connection.prompt.mock.calls[0]);
      expect(prompt).toContain(`workspace-mail-wake-${workspace.id}:${notice.revision}`);
      expect(prompt).toContain('You have workspace mail');
      expect(prompt).not.toContain('Recovered dedicated update');
    }
    expect(
      await db.prisma.workspaceNotification.findUniqueOrThrow({ where: { id: notice.id } })
    ).toMatchObject({ deliveredAt: null, acknowledgedAt: null });
    expect(
      await db.prisma.workspaceMailState.findUniqueOrThrow({ where: { workspaceId: workspace.id } })
    ).toMatchObject({ notifiedRevision: revoked ? 0 : notice.revision });
  }
);
