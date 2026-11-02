import { expect, it, vi } from 'vitest';
import { boundary } from '@/backend/orchestration/testing/event-delivery.test-support';
import type { ClaimedPRDelivery } from '@/shared/pr-monitoring';
import {
  context,
  consumer,
  db,
  h,
  providers,
  readyRetryPRFixture,
  strictStop,
} from '@/test-utils/event-generic-retry.test-support';

it.each([
  ['head', 'before'],
  ['batch', 'before'],
  ['head', 'during'],
  ['batch', 'during'],
] as const)(
  'outer %s rejection cannot settle a replacement frozen PR claim %s release',
  async (position, timing) => {
    const { other, workspace, guard, port } = await readyRetryPRFixture();
    const fail = vi.fn(port.fail);
    h.session.sessionBackgroundDeliveryService.configure({ ...port, fail });
    const held = boundary();
    const settlement = boundary();
    let published = false;
    let captured: ClaimedPRDelivery | undefined;
    const prepare = h.session.sessionBackgroundDeliveryService.prepare.bind(
      h.session.sessionBackgroundDeliveryService
    );
    vi.spyOn(h.session.sessionBackgroundDeliveryService, 'prepare').mockImplementation(
      async (...args) => {
        const result = await prepare(...args);
        if (result.status === 'ready' && !captured) {
          captured = result.delivery;
          published = true;
        }
        return result;
      }
    );
    const caller = {
      ...guard,
      check: async () => {
        await guard.check();
        if (published) {
          published = false;
          await held.wait();
          await guard.check();
        }
      },
    };
    const human = () =>
      h.session.sessionDomainService.enqueue(other.id, {
        id: 'human-with-replaced-claim',
        text: 'Keep human input',
        timestamp: '',
        settings: {
          selectedModel: null,
          reasoningEffort: null,
          thinkingEnabled: false,
          planModeEnabled: false,
        },
      });
    if (position === 'batch') {
      human();
    }
    h.session.sessionBackgroundDeliveryService.enqueue(other.id, {
      workspaceId: workspace.id,
      prId: 'first',
      bindingRevision: 1,
    });
    const message = h.session.sessionDomainService
      .getQueueSnapshot(other.id)
      .find((item) => item.source);
    if (!message) {
      throw new Error('Missing background token');
    }
    providers[1]!.connection.setSessionConfigOption.mockClear();
    const dispatch = h.session.sessionDispatchService
      .tryDispatchNextMessage(other.id, { guard: caller })
      .catch((error: unknown) => error);
    try {
      await held.entered;
      if (!captured) {
        throw new Error('Missing prepared claim');
      }
      expect(h.session.sessionBackgroundDeliveryService.isDeliveryActive(captured.deliveryId)).toBe(
        true
      );
      const settle = h.workspace.workspacePRMonitoringService.settleDelivery.bind(
        h.workspace.workspacePRMonitoringService
      );
      if (timing === 'during') {
        vi.spyOn(h.workspace.workspacePRMonitoringService, 'settleDelivery').mockImplementationOnce(
          async (input) => {
            await settlement.wait();
            return settle(input);
          }
        );
      }
      await strictStop();
      expect(
        await consumer.resolveAmbiguousRun({ ...(await context()), action: 'RETRY' })
      ).toMatchObject({ status: 'RETRIED' });
      await vi.waitFor(() => expect(providers).toHaveLength(3));
      await providers[2]!.called;
      providers[2]!.response.resolve({ stopReason: 'end_turn' });
      await consumer.drain();
      if (timing === 'during') {
        held.release();
        expect(
          await Promise.race([settlement.entered.then(() => true), dispatch.then(() => false)])
        ).toBe(true);
      }
      // The real owner reclaims the same frozen ID with a new attempt while the
      // old continuation is held before or inside its durable release.
      await settle({ ...captured, result: 'retry' });
      const replacement = await prepare(other.id, message);
      if (replacement.status !== 'ready') {
        throw new Error(`Replacement claim unavailable: ${JSON.stringify(replacement)}`);
      }
      expect(replacement.delivery).toMatchObject({
        deliveryId: captured.deliveryId,
        attempt: captured.attempt + 1,
      });
      if (position === 'head') {
        human();
      }
      const queue = structuredClone(h.session.sessionDomainService.getQueueSnapshot(other.id));
      settlement.release();
      held.release();
      await dispatch;
      expect(fail).toHaveBeenCalledExactlyOnceWith(
        captured,
        expect.objectContaining({ name: 'WorkspaceInitFenceError' })
      );
      expect(
        h.session.sessionBackgroundDeliveryService.isDeliveryActive(replacement.delivery.deliveryId)
      ).toBe(true);
      const events = await db.prisma.workspacePREvent.findMany({
        where: { workspaceId: workspace.id },
      });
      expect(events).toHaveLength(2);
      expect(events).toEqual(
        expect.arrayContaining(
          replacement.delivery.eventIds.map((id) =>
            expect.objectContaining({
              id,
              state: 'DISPATCHING',
              deliveryId: captured!.deliveryId,
              attempts: replacement.delivery.attempt,
            })
          )
        )
      );
      expect(await h.session.sessionBackgroundDeliveryService.validate(message)).toBe(true);
      expect(h.session.sessionDomainService.getQueueSnapshot(other.id)).toEqual(queue);
      expect(providers[1]!.connection.prompt).not.toHaveBeenCalled();
      expect(providers[1]!.connection.setSessionConfigOption).not.toHaveBeenCalled();
    } finally {
      held.release();
      settlement.release();
      await dispatch;
      await h.session.sessionBackgroundDeliveryService.fail(message, new Error('Fixture cleanup'));
    }
  }
);

it.each([false, true])(
  'an exhausted captured failure pauses only a current claim, replaced=%s',
  async (replaced) => {
    const { other, workspace, port } = await readyRetryPRFixture();
    await db.prisma.workspacePREvent.updateMany({
      where: { workspaceId: workspace.id },
      data: { attempts: 2 },
    });
    const request = { workspaceId: workspace.id, prId: 'first', bindingRevision: 1 };
    const prepared = await port.prepare({ sessionId: other.id, request });
    if (prepared.status !== 'ready') {
      throw new Error('Missing exhausted claim');
    }
    expect(prepared.delivery.attempt).toBe(3);
    if (replaced) {
      expect(
        await h.workspace.workspacePRMonitoringService.settleDelivery({
          ...prepared.delivery,
          result: 'retry',
        })
      ).toBe(true);
      // Exercise the existing durable owner directly to create the newer claim;
      // this isolates stale settlement/pause from retry-budget presentation policy.
      expect(
        await h.workspace.workspacePRMonitoringService.claimDelivery(
          { ...request, prId: null },
          prepared.delivery
        )
      ).toMatchObject({ deliveryId: prepared.delivery.deliveryId, attempt: 4 });
    }
    expect(await port.fail(prepared.delivery, new Error('Captured transport failed'))).toEqual({
      paused: !replaced,
    });
    expect(
      await db.prisma.workspacePRMonitoring.findUnique({ where: { workspaceId: workspace.id } })
    ).toMatchObject({ deliveryPauseReason: replaced ? null : 'DELIVERY_FAILED' });
    const events = await db.prisma.workspacePREvent.findMany({
      where: { workspaceId: workspace.id },
    });
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event).toMatchObject({
        state: replaced ? 'DISPATCHING' : 'PENDING',
        attempts: replaced ? 4 : 3,
      });
    }
  }
);

it('explicit stop cancels human input queued after entry cleanup while physical stop is held', async () => {
  const { other } = await readyRetryPRFixture();
  await strictStop();
  const held = boundary();
  const stop = h.session.acpRuntimeManager.stopAndQuiesce.bind(h.session.acpRuntimeManager);
  vi.spyOn(h.session.acpRuntimeManager, 'stopAndQuiesce').mockImplementationOnce(
    async (...args) => {
      await held.wait();
      return stop(...args);
    }
  );
  const stopping = h.session.sessionLifecycleService.stopSession(other.id, { reason: 'USER_STOP' });
  try {
    await held.entered;
    expect(h.session.sessionDomainService.getQueueLength(other.id)).toBe(0);
    h.session.sessionDomainService.enqueue(other.id, {
      id: 'late-human',
      text: 'Queued during stop',
      timestamp: '',
      settings: {
        selectedModel: null,
        reasoningEffort: null,
        thinkingEnabled: false,
        planModeEnabled: false,
      },
    });
    expect(h.session.sessionDomainService.getQueueLength(other.id)).toBe(1);
  } finally {
    held.release();
    await stopping;
  }
  expect(h.session.sessionDomainService.getQueueLength(other.id)).toBe(0);
  expect(h.session.acpRuntimeManager.getClient(other.id)).toBeUndefined();
});

it.each([false, true])(
  'obsolete ready recovery cannot fail a replacement SQLite claim, recoveryFails=%s',
  async (recoveryFails) => {
    const { other, workspace, port } = await readyRetryPRFixture();
    const service = h.session.sessionBackgroundDeliveryService;
    const held = boundary();
    let captured: ClaimedPRDelivery | undefined;
    let first = true;
    const fail = vi.fn(port.fail);
    service.configure({
      ...port,
      fail,
      prepare: async (input) => {
        const result = await port.prepare(input);
        if (first && result.status === 'ready') {
          first = false;
          captured = result.delivery;
          await held.wait();
        }
        return result;
      },
      recover: async (sessionId) => {
        await port.recover(sessionId);
        if (recoveryFails) {
          throw new Error('Receipt persistence unavailable');
        }
      },
    });
    const request = { workspaceId: workspace.id, prId: 'first', bindingRevision: 1 };
    service.enqueue(other.id, request);
    const old = h.session.sessionDomainService.peekNextMessage(other.id)!;
    const preparing = service.prepare(other.id, old).catch((error: unknown) => error);
    try {
      await held.entered;
      if (!captured) {
        throw new Error('Missing captured claim');
      }
      service.invalidate(workspace.id, 1);
      expect(
        await h.workspace.workspacePRMonitoringService.settleDelivery({
          ...captured,
          result: 'retry',
        })
      ).toBe(true);
      service.enqueue(other.id, request);
      const replacement = h.session.sessionDomainService.peekNextMessage(other.id)!;
      expect(replacement).not.toBe(old);
      const ready = await service.prepare(other.id, replacement);
      if (ready.status !== 'ready') {
        throw new Error('Replacement not ready');
      }
      expect(ready.delivery).toMatchObject({
        deliveryId: captured.deliveryId,
        attempt: captured.attempt + 1,
      });
      const queue = structuredClone(h.session.sessionDomainService.getQueueSnapshot(other.id));
      held.release();
      const result = await preparing;
      expect(result).toEqual(
        recoveryFails
          ? expect.objectContaining({ message: 'Receipt persistence unavailable' })
          : { status: 'discard' }
      );
      expect(fail).not.toHaveBeenCalled();
      expect(await service.validate(replacement)).toBe(true);
      expect(service.isDeliveryActive(ready.delivery.deliveryId)).toBe(true);
      expect(h.session.sessionDomainService.getQueueSnapshot(other.id)).toEqual(queue);
      const events = await db.prisma.workspacePREvent.findMany({
        where: { workspaceId: workspace.id },
      });
      expect(events).toHaveLength(2);
      for (const event of events) {
        expect(event).toMatchObject({
          state: 'DISPATCHING',
          attempts: 2,
          deliveryId: captured.deliveryId,
        });
      }
      await service.fail(replacement, new Error('Fixture cleanup'));
    } finally {
      held.release();
      await preparing;
    }
  }
);
