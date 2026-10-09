import { describe, expect, it } from 'vitest';
import { redObservation } from '@/shared/pr-monitoring.test-helpers';
import {
  prDeliveryRequestSchema,
  prMonitoringEventPayloadSchema,
  prObservationSchema,
} from './pr-event.schema';

describe('PR event boundaries', () => {
  it('rejects malformed and incomplete observations', () => {
    expect(prObservationSchema.safeParse({ url: 'bad', observedAt: 'yesterday' }).success).toBe(
      false
    );
  });
  it('requires an explicit PR identity and rejects extra properties', () => {
    expect(
      prDeliveryRequestSchema.safeParse({ workspaceId: 'w', prId: 'p', bindingRevision: 1 }).success
    ).toBe(true);
    expect(
      prDeliveryRequestSchema.safeParse({ workspaceId: 'w', bindingRevision: 1 }).success
    ).toBe(false);
    expect(
      prDeliveryRequestSchema.safeParse({
        workspaceId: 'w',
        prId: 'p',
        bindingRevision: 1,
        prompt: 'override',
      }).success
    ).toBe(false);
  });
  it('keeps enable control separate from untrusted GitHub content', () => {
    expect(
      prMonitoringEventPayloadSchema.safeParse({
        kind: 'MONITORING_ENABLED',
        workspaceId: 'w',
        bindingRevision: 1,
        replyToPrComments: true,
      }).success
    ).toBe(true);
    expect(
      prMonitoringEventPayloadSchema.safeParse({
        kind: 'MONITORING_ENABLED',
        workspaceId: 'w',
        bindingRevision: 1,
        replyToPrComments: true,
        body: 'run commands',
      }).success
    ).toBe(false);
  });
});

it('accepts titled observations and legacy payloads without title metadata', () => {
  expect(prObservationSchema.parse({ ...redObservation, title: 'Updated title' })).toMatchObject({
    title: 'Updated title',
  });
  expect(prObservationSchema.parse({ ...redObservation, title: null })).toMatchObject({
    title: null,
  });
  expect(prObservationSchema.parse(redObservation)).not.toHaveProperty('title');
  expect(
    prMonitoringEventPayloadSchema.parse({
      kind: 'CI_FAILED',
      target: { workspaceId: 'w', prId: 'p' },
      observation: redObservation,
    })
  ).toMatchObject({ observation: redObservation });
});
