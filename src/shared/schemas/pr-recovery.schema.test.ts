import { expect, it } from 'vitest';
import { prRecoverySchema, prDeliveryRecoverySchema } from './pr-recovery.schema';

function fixture() {
  return {
    deliveries: [
      {
        id: 'receipt',
        workspaceId: 'w',
        eventIds: ['second', 'first'],
        state: 'BLOCKED',
        sessionId: null,
        provider: null,
        providerSessionId: null,
        bindingRevision: null,
        text: null,
        attempts: 1,
        claimedAt: null,
        deliveredAt: null,
      },
    ],
    events: ['first', 'second'].map((id) => ({
      id,
      workspaceId: 'w',
      prId: null,
      batchId: 'receipt',
      kind: 'MONITORING_ENABLED',
      deduplicationKey: id,
      payload: {
        kind: 'MONITORING_ENABLED',
        workspaceId: 'w',
        bindingRevision: 1,
        replyToPrComments: true,
      },
      state: 'PENDING',
      attempts: 0,
      deliveryId: null,
      deliverySessionId: null,
      deliveryProvider: null,
      deliveryProviderSessionId: null,
      deliveryBindingRevision: null,
      deliveryText: null,
      claimedAt: null,
      deliveredAt: null,
      createdAt: '2026-11-01T00:00:00.000Z',
    })),
  };
}
it('retains original order and incomplete frozen metadata on a fully retained quarantined batch', () => {
  expect(prRecoverySchema.parse(fixture()).deliveries[0]?.eventIds).toEqual(['second', 'first']);
});
it('rejects missing or extra receipt members even when the effect is quarantined', () => {
  const missing = fixture();
  missing.events.pop();
  expect(prRecoverySchema.safeParse(missing).success).toBe(false);
  const extra = fixture();
  extra.deliveries[0]?.eventIds.pop();
  expect(prRecoverySchema.safeParse(extra).success).toBe(false);
});
it('rejects facts pointing to absent batches or borrowing a second receipt identity', () => {
  const absent = fixture();
  absent.deliveries = [];
  expect(prRecoverySchema.safeParse(absent).success).toBe(false);
  const conflicting = fixture();
  const event = conflicting.events[0];
  if (!event) {
    throw new Error('Missing fixture');
  }
  Object.assign(event, { deliveryId: 'another-receipt' });
  expect(prRecoverySchema.safeParse(conflicting).success).toBe(false);
});

it('bounds normalized frozen delivery text by UTF-8 bytes while preserving exact accepted text', () => {
  const delivery = { ...fixture().deliveries[0]!, text: '🙂'.repeat(4096) };
  expect(prDeliveryRecoverySchema.parse(delivery).text).toBe(delivery.text);
  expect(
    prDeliveryRecoverySchema.safeParse({ ...delivery, text: `${delivery.text}a` }).success
  ).toBe(false);
  expect(prDeliveryRecoverySchema.safeParse({ ...delivery, text: null }).success).toBe(true);
});
