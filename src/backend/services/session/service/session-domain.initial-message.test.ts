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
