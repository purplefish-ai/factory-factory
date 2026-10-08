import { expect, it } from 'vitest';
import { prEventBackupSchema, prMonitoringBackupSchema } from './pr-monitoring-backup.schema';

it('preserves enabled binding, durable pause, revisions and check time', () => {
  const config = {
    enabled: true,
    recipientSessionId: 'main',
    bindingRevision: 7,
    eventEpoch: 2,
    legacySessionIds: [],
    deliveryPauseReason: 'USER_STOPPED',
    lastCheckedAt: '2026-10-08T00:00:00.000Z',
  };
  expect(prMonitoringBackupSchema.parse(config)).toEqual(config);
});
it('rejects corrupt event JSON and invented receipt states', () => {
  expect(
    prEventBackupSchema.safeParse({
      id: 'e',
      workspaceId: 'w',
      prId: null,
      kind: 'MONITORING_ENABLED',
      deduplicationKey: 'key',
      payload: 'corrupt',
      state: 'DELIVERED',
    }).success
  ).toBe(false);
});
