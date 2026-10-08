import { expect, it } from 'vitest';
import { redObservation } from '@/shared/pr-monitoring.test-helpers';
import { buildPREventMessage } from './pr-event';

it('bounds UTF-8 feedback and retains identity, marker and omitted count', () => {
  const review = {
    identity: 'r',
    contentHash: 'h',
    author: 'person',
    body: '🦊'.repeat(20_000),
    path: 'a.ts',
    line: 1,
    url: redObservation.url,
    activityAt: redObservation.observedAt,
  };
  const text = buildPREventMessage({
    deliveryId: 'receipt',
    events: [
      {
        kind: 'REVIEW_FEEDBACK',
        target: { workspaceId: 'w', prId: 'p' },
        observation: redObservation,
        reviews: [review],
      },
    ],
    replyToPrComments: false,
  });
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(16_384);
  expect(text).toContain('factory-factory-pr-event:receipt');
  expect(text).toContain(redObservation.url);
  expect(text).toContain('omitted');
  expect(text).toContain('Do not post');
});
it('uses the workflow instruction only for trusted enable controls', () => {
  const text = buildPREventMessage({
    deliveryId: 'control',
    events: [
      { kind: 'MONITORING_ENABLED', workspaceId: 'w', bindingRevision: 1, replyToPrComments: true },
    ],
    replyToPrComments: true,
  });
  expect(text).toContain('Keep the associated PRs moving');
  expect(text).toContain('Do not merge');
});
