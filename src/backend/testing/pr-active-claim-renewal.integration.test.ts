import { expect, it, vi } from 'vitest';
import {
  db,
  h,
  readyRetryPRFixture,
  readPRDeliveryEvents,
} from '@/test-utils/event-generic-retry.test-support';

it.each([
  ['session-resume', 'delivered'],
  ['session-resume', 'absent'],
  ['session-resume', 'unavailable'],
  ['set-binding', 'delivered'],
  ['set-binding', 'absent'],
  ['set-binding', 'unavailable'],
] as const)(
  'active third attempt after %s recovers on the next production wake with receipt=%s',
  async (renewal, receipt) => {
    const { other, workspace } = await readyRetryPRFixture();
    const { createDefaultApplicationDependencies } =
      await vi.importActual<typeof import('@/backend/app-context')>('@/backend/app-context');
    const { createPRBackgroundDeliveryPort } = await vi.importActual<
      typeof import('@/backend/orchestration/pr-event-delivery-port')
    >('@/backend/orchestration/pr-event-delivery-port');
    const { defaultPRDeliveryPorts } = await vi.importActual<
      typeof import('@/backend/orchestration/pr-delivery-dependencies')
    >('@/backend/orchestration/pr-delivery-dependencies');
    const findReceipt = vi.fn(async () => receipt);
    const graph = createDefaultApplicationDependencies();
    const dispatch = vi
      .spyOn(h.session.sessionDispatchService, 'tryDispatchNextMessage')
      .mockResolvedValue();
    graph.lifecycle.wireDomainBridges({ ...graph.services, findPRDeliveryReceipt: findReceipt });
    const port = createPRBackgroundDeliveryPort({
      ...defaultPRDeliveryPorts,
      findPRDeliveryReceipt: findReceipt,
      refreshObservation: async () => true,
    });
    const owner = h.session.sessionBackgroundDeliveryService;
    owner.configure(port);
    await db.prisma.workspacePREvent.updateMany({
      where: { workspaceId: workspace.id },
      data: { attempts: 2 },
    });
    owner.enqueue(other.id, { workspaceId: workspace.id, prId: 'first', bindingRevision: 1 });
    const message = h.session.sessionDomainService.peekNextMessage(other.id)!;
    const ready = await owner.prepare(other.id, message);
    if (ready.status !== 'ready') {
      throw new Error('Missing active third attempt');
    }
    expect(ready.delivery.attempt).toBe(3);
    expect(owner.isDeliveryActive(ready.delivery.deliveryId)).toBe(true);
    await port.pause(other.id, 'USER_STOPPED');
    const paused = await h.workspace.workspacePRMonitoringService.get(workspace.id);
    if (!paused) {
      throw new Error('Missing paused binding');
    }
    if (renewal === 'session-resume') {
      await port.resume(other.id);
    } else {
      expect(
        await h.workspace.workspacePRMonitoringService.setBinding({
          workspaceId: workspace.id,
          enabled: true,
          expectedBindingRevision: paused.bindingRevision,
          resume: true,
        })
      ).toMatchObject({ applied: true });
    }
    const current = await h.workspace.workspacePRMonitoringService.get(workspace.id);
    if (!current) {
      throw new Error('Missing resumed binding');
    }
    expect(current).toMatchObject({
      bindingRevision: paused.bindingRevision + 1,
      deliveryPauseReason: null,
    });
    const rows = () => readPRDeliveryEvents(workspace.id);
    expect(await rows()).toEqual(
      expect.arrayContaining(
        ready.delivery.eventIds.map((id) =>
          expect.objectContaining({
            id,
            state: 'DISPATCHING',
            attempts: 0,
            deliveryBindingRevision: ready.delivery.bindingRevision,
          })
        )
      )
    );
    const settle = vi.spyOn(h.workspace.workspacePRMonitoringService, 'settleDelivery');
    findReceipt.mockClear();
    if (receipt === 'delivered') {
      await owner.complete(message);
    } else {
      await owner.fail(message, new Error('Transport ended after resume'));
    }
    expect(settle).toHaveBeenCalledExactlyOnceWith({
      ...ready.delivery,
      result: receipt === 'delivered' ? 'delivered' : 'retry',
    });
    expect(await settle.mock.results[0]!.value).toBe(false);
    expect(owner.isDeliveryActive(ready.delivery.deliveryId)).toBe(false);
    expect(findReceipt).not.toHaveBeenCalled();
    expect(await rows()).toEqual(
      expect.arrayContaining(
        ready.delivery.eventIds.map((id) =>
          expect.objectContaining({ id, state: 'DISPATCHING', attempts: 0 })
        )
      )
    );
    // This is the bridge callback used by a subsequent idle/regular-poll wake.
    // No polling interval is waited and automatic provider dispatch is a fake port.
    await graph.services.ratchetService.wakePendingEvents(workspace.id);
    expect(findReceipt).toHaveBeenCalledWith(other.id, ready.delivery.deliveryId);
    if (receipt === 'delivered') {
      expect((await rows()).map((row) => row.state)).toEqual(
        ready.delivery.eventIds.map(() => 'DELIVERED')
      );
      return;
    }
    if (receipt === 'unavailable') {
      expect(await h.workspace.workspacePRMonitoringService.get(workspace.id)).toMatchObject({
        deliveryPauseReason: 'RECEIPT_UNAVAILABLE',
      });
      expect(owner.isDeliveryActive(ready.delivery.deliveryId)).toBe(false);
      return;
    }
    for (const row of await rows()) {
      expect(row.state).toBe('PENDING');
    }
    expect(dispatch).toHaveBeenCalledWith(other.id);
    const next = h.session.sessionDomainService
      .getQueueSnapshot(other.id)
      .find((item) => item.source?.request.bindingRevision === current.bindingRevision);
    if (!next) {
      throw new Error('Missing current-binding queued claim');
    }
    const reclaimed = await owner.prepare(other.id, next);
    if (reclaimed.status !== 'ready') {
      throw new Error('Current-binding reclaim blocked');
    }
    expect(reclaimed.delivery).toMatchObject({
      deliveryId: ready.delivery.deliveryId,
      attempt: 1,
      bindingRevision: current.bindingRevision,
    });
    expect(await port.fail(ready.delivery, new Error('Late old failure'))).toEqual({
      paused: false,
    });
    expect(await owner.validate(next)).toBe(true);
    for (const row of await rows()) {
      expect(row).toMatchObject({
        state: 'DISPATCHING',
        attempts: 1,
        deliveryBindingRevision: current.bindingRevision,
      });
    }
    expect(await h.workspace.workspacePRMonitoringService.get(workspace.id)).toMatchObject({
      deliveryPauseReason: null,
    });
    await owner.fail(next, new Error('Fixture cleanup'));
  }
);
