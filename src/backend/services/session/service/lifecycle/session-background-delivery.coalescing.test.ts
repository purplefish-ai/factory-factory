import { expect, it } from 'vitest';
import { sessionDomainService } from '@/backend/services/session/service/session-domain.service';
import type { PRDeliveryRequest } from '@/shared/pr-monitoring';
import { SessionBackgroundDeliveryService } from './session-background-delivery.service';

const request = { workspaceId: 'w', prId: 'p', bindingRevision: 1 };
const settings = {
  selectedModel: null,
  reasoningEffort: null,
  thinkingEnabled: false,
  planModeEnabled: false,
};
function configureReadyService(sessionId: string) {
  const service = new SessionBackgroundDeliveryService();
  let claim = 0;
  service.configure({
    prepare: async () => ({
      status: 'ready',
      delivery: {
        deliveryId: `delivery-${sessionId}-${++claim}`,
        sessionId,
        bindingRevision: 1,
        eventIds: ['event-p', 'event-q'],
        text: 'All pending PR facts',
        attempt: 1,
      },
    }),
    validate: async () => true,
    complete: async () => undefined,
    fail: async () => ({ paused: false }),
    recover: async () => undefined,
    pause: async () => undefined,
    resume: async () => undefined,
  });
  return service;
}
function queuedPR(sessionId: string, prId: string | null) {
  const message = sessionDomainService
    .getQueueSnapshot(sessionId)
    .find((message) => message.source?.request.prId === prId);
  if (!message) {
    throw new Error(`Missing queued PR ${prId}`);
  }
  return message;
}
it('silently removes redundant main placeholders while retaining humans and other destinations', async () => {
  const sessionId = 'main-batch-placeholder-coalescing';
  const service = configureReadyService(sessionId);
  service.enqueue(sessionId, request);
  service.enqueue(sessionId, { ...request, prId: 'q' });
  const current = queuedPR(sessionId, 'p');
  const redundant = queuedPR(sessionId, 'q');
  const excluded: PRDeliveryRequest[] = [
    { ...request, prId: 'new-binding', bindingRevision: 2 },
    { ...request, prId: 'dedicated', deliveryMode: 'DEDICATED' },
    { ...request, prId: 'other-workspace', workspaceId: 'other' },
  ];
  for (const other of excluded) {
    service.enqueue(sessionId, other);
  }
  service.enqueue(`${sessionId}-sibling`, { ...request, prId: 'q' });
  sessionDomainService.enqueue(sessionId, {
    id: 'human',
    text: 'Work on all updates',
    timestamp: '',
    settings,
  });

  expect((await service.prepare(sessionId, current)).status).toBe('ready');
  expect(sessionDomainService.getQueueSnapshot(sessionId).map((message) => message.id)).toEqual([
    'human',
    current.id,
    ...excluded.map((other) => queuedPR(sessionId, other.prId).id),
  ]);
  expect(sessionDomainService.hasQueuedMessage(sessionId, redundant.id)).toBe(false);
  expect(sessionDomainService.getTranscriptSnapshot(sessionId)).toEqual([]);
  expect(sessionDomainService.getQueueLength(`${sessionId}-sibling`)).toBe(1);

  service.enqueue(sessionId, { ...request, prId: 'q' });
  expect(queuedPR(sessionId, 'q')).not.toBe(redundant);
});
it('preserves an active main claim when coalescing another ready batch', async () => {
  const sessionId = 'active-claim-placeholder-coalescing';
  const service = configureReadyService(sessionId);
  service.enqueue(sessionId, { ...request, prId: 'q' });
  const active = queuedPR(sessionId, 'q');
  const prepared = await service.prepare(sessionId, active);
  if (prepared.status !== 'ready') {
    throw new Error('Missing active claim');
  }
  service.enqueue(sessionId, request);
  const next = queuedPR(sessionId, 'p');
  await service.prepare(sessionId, next);
  expect(queuedPR(sessionId, 'q')).toBe(active);
  expect(service.isDeliveryActive(prepared.delivery.deliveryId)).toBe(true);
  expect(await service.validate(active)).toBe(true);
});
it('does not coalesce other PR placeholders for a dedicated claim', async () => {
  const sessionId = 'dedicated-placeholder-coalescing';
  const service = configureReadyService(sessionId);
  service.enqueue(sessionId, { ...request, deliveryMode: 'DEDICATED' });
  service.enqueue(sessionId, { ...request, prId: 'q' });
  service.enqueue(sessionId, { ...request, prId: 'r', deliveryMode: 'DEDICATED' });
  await service.prepare(sessionId, queuedPR(sessionId, 'p'));
  expect(
    sessionDomainService.getQueueSnapshot(sessionId).map((message) => message.source?.request.prId)
  ).toEqual(['p', 'q', 'r']);
  expect(sessionDomainService.getTranscriptSnapshot(sessionId)).toEqual([]);
});
