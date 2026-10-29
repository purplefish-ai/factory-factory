import { beforeEach, expect, it, vi } from 'vitest';
import type { QueuedMessage } from '@/shared/acp-protocol';
import { SessionDomainService } from './session-domain.service';

let domain: SessionDomainService;
const message: QueuedMessage = {
  id: 'auto-init-first',
  text: 'Initial task',
  timestamp: '2026-10-29T00:00:00.000Z',
  settings: {
    selectedModel: null,
    reasoningEffort: null,
    thinkingEnabled: false,
    planModeEnabled: false,
  },
};

beforeEach(() => {
  domain = new SessionDomainService();
});

it.each([false, true])(
  'keeps an initial task cancelled when provisioning retries (store cleared: %s)',
  (clearStore) => {
    expect(domain.enqueueInitialMessage('session-1', message)).toEqual({ position: 0 });
    expect(domain.getQueueSnapshot('session-1')).toEqual([message]);
    expect(
      domain.enqueueInitialMessage('session-1', { ...message, id: 'auto-init-retry' })
    ).toBeNull();
    expect(domain.getQueueSnapshot('session-1')).toEqual([message]);
    domain.removeQueuedMessage('session-1', message.id);
    if (clearStore) {
      domain.clearSession('session-1');
    }
    expect(
      domain.enqueueInitialMessage('session-1', { ...message, id: 'auto-init-retry' })
    ).toBeNull();
    expect(domain.getQueueSnapshot('session-1')).toEqual([]);
  }
);

it('allows initial publication to retry when enqueue fails', () => {
  const enqueue = vi.spyOn(domain, 'enqueue').mockReturnValueOnce({ error: 'Queue full' });
  expect(domain.enqueueInitialMessage('session-1', message)).toEqual({ error: 'Queue full' });
  enqueue.mockRestore();
  expect(domain.enqueueInitialMessage('session-1', message)).toEqual({ position: 0 });
  expect(domain.getQueueSnapshot('session-1')).toEqual([message]);
});

it('preserves queued work while resetting cached session state after disconnect', () => {
  const followup = { ...message, id: 'followup', text: 'Check the tests too' };
  domain.enqueueInitialMessage('session-1', message);
  domain.enqueue('session-1', followup);
  domain.injectCommittedUserMessage('session-1', 'Cached history');
  domain.markHistoryHydrated('session-1', 'acp_fallback');
  domain.markRunning('session-1');
  domain.clearSession('session-1', { preserveRejections: true });
  expect(domain.getQueueSnapshot('session-1')).toEqual([message, followup]);
  expect(domain.getTranscriptSnapshot('session-1')).toEqual([]);
  expect(domain.isHistoryHydrated('session-1')).toBe(false);
  expect(domain.getHistoryHydrationSource('session-1')).toBeUndefined();
  expect(domain.getRuntimeSnapshot('session-1')).toMatchObject({
    phase: 'idle',
    processState: 'stopped',
    activity: 'IDLE',
  });
  expect(domain.enqueueInitialMessage('session-1', { ...message, id: 'retry' })).toBeNull();
  expect(domain.getQueueSnapshot('session-1')).toEqual([message, followup]);
});

it('republishes an undelivered task after its queue is destructively cleared', () => {
  domain.enqueueInitialMessage('session-1', message);
  domain.clearSession('session-1');
  const retry = { ...message, id: 'retry' };
  expect(domain.enqueueInitialMessage('session-1', retry)).toEqual({ position: 0 });
  expect(domain.getQueueSnapshot('session-1')).toEqual([retry]);
});
