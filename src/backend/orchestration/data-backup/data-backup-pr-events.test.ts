import { expect, it, vi } from 'vitest';
import { exportPRBackupState } from './data-backup-pr-events';

vi.mock('@/backend/db', () => ({ prisma: {} }));

it('flattens every frozen delivery member into the compatible backup without batchId', () => {
  const eventIds = ['frozen-a', 'frozen-b'];
  const workspace: Parameters<typeof exportPRBackupState>[0] = {
    prs: [],
    prMonitoring: null,
    prDiscovery: null,
    prEvents: eventIds.map((id) => ({
      id,
      workspaceId: 'ws-1',
      prId: null,
      kind: 'MONITORING_ENABLED',
      deduplicationKey: id,
      payload: {
        kind: 'MONITORING_ENABLED',
        workspaceId: 'ws-1',
        bindingRevision: 7,
        replyToPrComments: true,
      },
      state: 'PENDING',
      attempts: 0,
      batchId: 'frozen-receipt',
      deliveryId: null,
      deliverySessionId: null,
      deliveryProvider: null,
      deliveryProviderSessionId: null,
      deliveryBindingRevision: null,
      deliveryText: null,
      claimedAt: null,
      deliveredAt: null,
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
    })),
    prDeliveries: [
      {
        id: 'frozen-receipt',
        workspaceId: 'ws-1',
        eventIds,
        state: 'DISPATCHING',
        sessionId: 'session-1',
        provider: 'CODEX',
        providerSessionId: 'thread-123',
        bindingRevision: 7,
        text: 'exact frozen batch',
        attempts: 2,
        claimedAt: new Date('2025-01-01T00:01:00.000Z'),
        deliveredAt: null,
      },
    ],
  };
  const result = exportPRBackupState(workspace);
  const events = result.prEvents;
  expect(events).toHaveLength(2);
  expect(events?.map((event) => event.id)).toEqual(['frozen-a', 'frozen-b']);
  for (const event of events ?? []) {
    expect(event).toMatchObject({
      deliveryId: 'frozen-receipt',
      deliveryText: 'exact frozen batch',
      state: 'DISPATCHING',
      attempts: 2,
      deliverySessionId: 'session-1',
      deliveryProvider: 'CODEX',
      deliveryProviderSessionId: 'thread-123',
      deliveryBindingRevision: 7,
      claimedAt: '2025-01-01T00:01:00.000Z',
    });
    expect(event).not.toHaveProperty('batchId');
  }
});
