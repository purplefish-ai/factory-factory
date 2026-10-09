import { describe, expect, it } from 'vitest';
import { redObservation } from '@/shared/pr-monitoring.test-helpers';
import {
  prDeliveryRequestSchema,
  prFactPayloadSchema,
  prMonitoringControlPayloadSchema,
  prMonitoringEventPayloadSchema,
  prObservationSchema,
} from './pr-event.schema';

describe('PR event boundaries', () => {
  it('accepts facts and controls only through their own strict boundary', () => {
    const fact = {
      kind: 'CI_FAILED',
      target: { workspaceId: 'w', prId: 'p' },
      observation: redObservation,
    };
    const control = {
      kind: 'MONITORING_ENABLED',
      workspaceId: 'w',
      bindingRevision: 1,
      replyToPrComments: true,
    };
    expect(prFactPayloadSchema.safeParse(fact).success).toBe(true);
    expect(prFactPayloadSchema.safeParse(control).success).toBe(false);
    expect(prFactPayloadSchema.safeParse({ ...fact, deliveryMode: 'DEDICATED' }).success).toBe(
      false
    );
    expect(prMonitoringControlPayloadSchema.safeParse(control).success).toBe(true);
    expect(prMonitoringControlPayloadSchema.safeParse(fact).success).toBe(false);
    expect(
      prMonitoringControlPayloadSchema.safeParse({ ...control, observation: redObservation })
        .success
    ).toBe(false);
    expect(prMonitoringEventPayloadSchema.parse(fact)).toEqual(fact);
    expect(prMonitoringEventPayloadSchema.parse(control)).toEqual(control);
  });
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
it('keeps old queue requests valid and validates explicit delivery destinations', () => {
  const request = { workspaceId: 'w', prId: 'p', bindingRevision: 1 };
  expect(prDeliveryRequestSchema.parse(request)).toEqual(request);
  expect(prDeliveryRequestSchema.parse({ ...request, deliveryMode: 'DEDICATED' })).toMatchObject({
    deliveryMode: 'DEDICATED',
  });
  expect(prDeliveryRequestSchema.safeParse({ ...request, deliveryMode: 'OTHER' }).success).toBe(
    false
  );
});
