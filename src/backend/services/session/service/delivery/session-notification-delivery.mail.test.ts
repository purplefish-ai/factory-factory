import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, QueuedMessage } from '@/shared/acp-protocol';
import { SessionNotificationDeliveryService } from './session-notification-delivery.service';

const wake = { workspaceId: 'workspace-1', revision: 12, claimId: 'claim-1' };
function harness() {
  const notificationPort = {
    listPendingForDelivery: vi.fn(async () => []),
    findForDelivery: vi.fn(async () => null),
    markDelivered: vi.fn(async () => undefined),
    claimWake: vi.fn(async () => wake),
    settleWake: vi.fn(async () => true),
    releaseWake: vi.fn(async () => undefined),
    quarantineWake: vi.fn(async () => true),
    disarmWake: vi.fn(async () => true),
  };
  const queuePort = {
    hasQueuedMessage: vi.fn<(sessionId: string, messageId: string) => boolean>(() => false),
    enqueue: vi.fn<
      (sessionId: string, message: QueuedMessage) => { position: number } | { error: string }
    >(() => ({ position: 0 })),
    removeQueuedMessage: vi.fn(() => true),
  };
  const transcriptPort = {
    getTranscriptSnapshot: vi.fn((_sessionId: string): ChatMessage[] => []),
    getHistoryHydrationSource: vi.fn(() => 'none' as const),
    appendClaudeEvent: vi.fn(() => 1),
  };
  const deltaPort = { emitDelta: vi.fn() };
  const service = new SessionNotificationDeliveryService({
    notificationPort,
    queuePort,
    transcriptPort,
    deltaPort,
  });
  const recover = (assertAllowed: () => void | Promise<void> = vi.fn()) =>
    service.recoverPending({
      sessionId: 'session-1',
      workspaceId: wake.workspaceId,
      assertAllowed,
    });
  return { service, notificationPort, queuePort, transcriptPort, deltaPort, recover };
}

describe('durable workspace mail wakes', () => {
  beforeEach(() => vi.clearAllMocks());
  it('queues one bounded body-free signal and keeps mail acknowledgement separate', async () => {
    const h = harness();
    expect(await h.recover()).toEqual({ dispatchableCount: 1 });
    expect(h.notificationPort.claimWake).toHaveBeenCalledWith({ workspaceId: 'workspace-1' });
    expect(h.queuePort.enqueue).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        id: 'workspace-mail-wake-workspace-1:12',
        text: expect.stringContaining('list_mail'),
      })
    );
    expect(h.queuePort.enqueue.mock.calls[0]?.[1].text.length).toBeLessThan(512);
    expect(h.notificationPort.listPendingForDelivery).not.toHaveBeenCalled();
    expect(h.transcriptPort.appendClaudeEvent).not.toHaveBeenCalled();
    expect(h.notificationPort.settleWake).not.toHaveBeenCalled();
    await h.service.acknowledgeSuccessfulDispatch('workspace-mail-wake-workspace-1:12');
    expect(h.notificationPort.settleWake).toHaveBeenCalledWith(wake);
    expect(h.notificationPort.markDelivered).not.toHaveBeenCalled();
  });
  it('coalesces recovery while a signal remains queued', async () => {
    const h = harness();
    await h.recover();
    h.queuePort.hasQueuedMessage.mockReturnValue(true);
    expect(await h.recover()).toEqual({ dispatchableCount: 1 });
    expect(h.queuePort.enqueue).toHaveBeenCalledTimes(1);
    expect(h.notificationPort.claimWake).toHaveBeenCalledTimes(1);
  });
  it('releases a full-queue claim and retries when queue progress permits it', async () => {
    const h = harness();
    h.queuePort.enqueue.mockReturnValueOnce({ error: 'queue full' });
    expect(await h.recover()).toEqual({ dispatchableCount: 0 });
    expect(h.notificationPort.releaseWake).toHaveBeenCalledWith(wake);
    expect(await h.recover()).toEqual({ dispatchableCount: 1 });
    expect(h.queuePort.enqueue).toHaveBeenCalledTimes(2);
  });
  it('releases a durable claim when the captured caller guard rejects recovery', async () => {
    const h = harness();
    await h.recover(() => {
      throw new Error('caller replaced');
    });
    expect(h.queuePort.enqueue).not.toHaveBeenCalled();
    expect(h.notificationPort.releaseWake).toHaveBeenCalledWith(wake);
  });
  it('does not count a provisional transcript entry as delivered while its send is unsettled', async () => {
    const h = harness();
    await h.recover();
    const messageId = 'workspace-mail-wake-workspace-1:12';
    const claim = h.service.claimForDispatch('session-1', messageId);
    expect(claim.status).toBe('claimed');
    h.service.resetSession('session-1');
    h.transcriptPort.getTranscriptSnapshot.mockReturnValue([
      { id: messageId, source: 'user', text: 'mail', timestamp: '2026-11-13T00:00:00Z', order: 0 },
    ]);
    const retry = h.service.claimForDispatch('session-1', messageId);
    expect(retry.status).not.toBe('duplicate');
    for (const held of [claim, retry]) {
      if (held.status === 'claimed') {
        held.release();
      }
    }
  });
  it('keeps in-flight provider input unsettled across session reset', async () => {
    const h = harness();
    await h.recover();
    const claim = h.service.claimForDispatch('session-1', 'workspace-mail-wake-workspace-1:12');
    expect(claim.status).toBe('claimed');
    h.service.resetSession('session-1');
    expect(await h.recover()).toEqual({ dispatchableCount: 0 });
    expect(h.notificationPort.settleWake).not.toHaveBeenCalled();
    if (claim.status === 'claimed') {
      claim.release();
    }
  });
});

it('releases a replacement ambiguous claim if authority rejects after acquisition', async () => {
  const h = harness();
  await h.recover();
  h.service
    .captureMailSignalReceipt('session-1', 'workspace-mail-wake-workspace-1:12')!
    .quarantine();
  const replacement = { ...wake, claimId: 'replacement' };
  const guard = vi
    .fn()
    .mockReturnValueOnce(undefined)
    .mockRejectedValueOnce(new Error('session stopped'));
  h.notificationPort.claimWake.mockResolvedValueOnce(replacement);
  await h.recover(guard);
  expect(h.notificationPort.releaseWake).toHaveBeenCalledExactlyOnceWith(replacement);
  expect(h.queuePort.enqueue).toHaveBeenCalledTimes(1);
});

it('forgets reset session recovery mappings and preferred recipient authority', async () => {
  const h = harness();
  const authority = vi.fn();
  await h.service.recoverPending({
    sessionId: 'session-1',
    workspaceId: wake.workspaceId,
    assertAllowed: authority,
    preferSession: true,
  });
  h.service.resetSession('session-1');
  h.queuePort.hasQueuedMessage.mockReturnValue(true);
  await h.service.recoverSession('session-1', authority);
  expect(authority).toHaveBeenCalledTimes(1);
  // Inspect retained identity maps to cover removal of the captured authority closure.
  expect(Reflect.get(h.service, 'sessionWorkspaces').size).toBe(0);
  expect(Reflect.get(h.service, 'preferredRecipients').size).toBe(0);
});

it('requests one recovery at the durable claim lease expiry after a restart', async () => {
  const h = harness();
  const retryAt = new Date(Date.now() + 30_000);
  h.notificationPort.claimWake.mockResolvedValueOnce(null as never);
  const nextWakeRetryAt = vi.fn(async () => retryAt);
  Object.assign(h.notificationPort, { nextWakeRetryAt });
  const retry = vi.fn();
  h.service.configureRetry(retry);
  expect(await h.recover()).toEqual({ dispatchableCount: 0 });
  expect(retry).toHaveBeenCalledExactlyOnceWith({
    sessionId: 'session-1',
    workspaceId: 'workspace-1',
    retryAt,
    assertAllowed: expect.any(Function),
  });
  expect(h.queuePort.enqueue).not.toHaveBeenCalled();
});

it('transfers a queued wake from an older recipient to the newly selected session', async () => {
  const h = harness();
  await h.recover();
  h.queuePort.hasQueuedMessage.mockImplementation((sessionId: string) => sessionId === 'session-1');
  expect(
    await h.service.recoverPending({
      sessionId: 'session-2',
      workspaceId: 'workspace-1',
      assertAllowed: () => undefined,
      preferSession: true,
    })
  ).toEqual({ dispatchableCount: 1 });
  expect(h.queuePort.removeQueuedMessage).toHaveBeenCalledWith(
    'session-1',
    'workspace-mail-wake-workspace-1:12'
  );
  expect(h.queuePort.enqueue).toHaveBeenLastCalledWith(
    'session-2',
    expect.objectContaining({ id: 'workspace-mail-wake-workspace-1:12' })
  );
});

it('retains preferred transfer while the older recipient recovery is still claiming', async () => {
  const h = harness();
  let release!: (value: typeof wake) => void;
  const claiming = new Promise<typeof wake>((resolve) => {
    release = resolve;
  });
  h.notificationPort.claimWake.mockReturnValueOnce(claiming);
  h.queuePort.hasQueuedMessage.mockImplementation((id) =>
    h.queuePort.enqueue.mock.calls.some(([session]) => session === id)
  );
  const old = h.recover();
  const selectedGuard = vi.fn();
  const selected = h.service.recoverPending({
    sessionId: 'session-2',
    workspaceId: wake.workspaceId,
    preferSession: true,
    assertAllowed: selectedGuard,
  });
  release(wake);
  await old;
  expect(await selected).toEqual({ dispatchableCount: 1 });
  expect(h.queuePort.enqueue).toHaveBeenLastCalledWith(
    'session-2',
    expect.objectContaining({ id: 'workspace-mail-wake-workspace-1:12' })
  );
  expect(h.queuePort.removeQueuedMessage).toHaveBeenCalledWith(
    'session-1',
    'workspace-mail-wake-workspace-1:12'
  );
  expect(selectedGuard).toHaveBeenCalled();
  await h.service.recoverSession('session-1', () => undefined);
  expect(h.queuePort.enqueue).toHaveBeenCalledTimes(2);
});
