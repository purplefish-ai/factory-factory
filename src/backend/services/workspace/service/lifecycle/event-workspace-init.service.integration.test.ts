import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createEventDeliveryFixture } from '@/backend/orchestration/testing/event-delivery.test-support';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
let db: IntegrationDatabase;
let h: Awaited<ReturnType<typeof createEventDeliveryFixture>>;
let accessor: typeof import('@/backend/services/workspace/resources/workspace-event-init.accessor').workspaceEventInitAccessor;
beforeEach(async () => {
  db = await createIntegrationDatabase();
  h = await createEventDeliveryFixture(db, 'CLAUDE', false);
  accessor = (
    await vi.importActual<
      typeof import('@/backend/services/workspace/resources/workspace-event-init.accessor')
    >('@/backend/services/workspace/resources/workspace-event-init.accessor')
  ).workspaceEventInitAccessor;
  await h.workspace.eventWorkspaceInitService.start(h.claim);
});
afterEach(async () => {
  try {
    h.workspace.workspaceStateMachine.removeAllListeners(h.workspace.WORKSPACE_STATE_CHANGED);
  } finally {
    vi.restoreAllMocks();
    await destroyIntegrationDatabase(db);
  }
});
function afterCommit(change: () => void | Promise<void>) {
  const finish = accessor.finish;
  vi.spyOn(accessor, 'finish').mockImplementation(async (...args) => {
    const result = await finish(...args);
    await change();
    return result;
  });
}
it('publishes the fresh READY row after unrelated metadata changes', async () => {
  afterCommit(async () => {
    await db.prisma.workspace.update({
      where: { id: h.claim.reservedWorkspaceId },
      data: { name: 'Fresh metadata', updatedAt: new Date(Date.now() + 1000) },
    });
  });
  const observed = vi.fn();
  h.workspace.workspaceStateMachine.on(h.workspace.WORKSPACE_STATE_CHANGED, observed);
  await h.workspace.eventWorkspaceInitService.finish(h.claim, 'READY');
  expect(observed).toHaveBeenCalledWith(
    expect.objectContaining({
      toStatus: 'READY',
      workspace: expect.objectContaining({ name: 'Fresh metadata' }),
    })
  );
});
it.each(['generation', 'archive', 'delete'] as const)(
  'rejects publication after %s supersedes the committed transition',
  async (change) => {
    afterCommit(async () => {
      if (change === 'generation') {
        await db.prisma.agentRun.update({
          where: { id: h.claim.runId },
          data: { workerGeneration: { increment: 1 } },
        });
      } else if (change === 'delete') {
        await db.prisma.workspace.delete({ where: { id: h.claim.reservedWorkspaceId } });
      } else {
        await db.prisma.workspace.update({
          where: { id: h.claim.reservedWorkspaceId },
          data: { status: 'ARCHIVED' },
        });
      }
    });
    const observed = vi.fn();
    h.workspace.workspaceStateMachine.on(h.workspace.WORKSPACE_STATE_CHANGED, observed);
    await expect(h.workspace.eventWorkspaceInitService.finish(h.claim, 'READY')).rejects.toThrow(
      /no longer current/
    );
    expect(observed).not.toHaveBeenCalled();
  }
);
it('does not turn an authority reread error into successful READY', async () => {
  afterCommit(() => {
    vi.spyOn(accessor, 'read').mockRejectedValue(new Error('Authority unavailable'));
  });
  await expect(h.workspace.eventWorkspaceInitService.finish(h.claim, 'READY')).rejects.toThrow(
    'Authority unavailable'
  );
});
it('isolates each notification subscriber after current READY validation', async () => {
  const observed = vi.fn();
  h.workspace.workspaceStateMachine.on(h.workspace.WORKSPACE_STATE_CHANGED, () => {
    throw new Error('private subscriber detail');
  });
  h.workspace.workspaceStateMachine.once(h.workspace.WORKSPACE_STATE_CHANGED, observed);
  await expect(
    h.workspace.eventWorkspaceInitService.finish(h.claim, 'READY')
  ).resolves.toMatchObject({ status: 'READY' });
  expect(observed).toHaveBeenCalledOnce();
  expect(h.workspace.workspaceStateMachine.listenerCount(h.workspace.WORKSPACE_STATE_CHANGED)).toBe(
    1
  );
});
