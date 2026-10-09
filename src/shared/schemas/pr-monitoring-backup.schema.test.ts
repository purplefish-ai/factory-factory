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
  expect(prMonitoringBackupSchema.parse(config)).toEqual({ ...config, deliveryMode: 'MAIN' });
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
const frozenEvent = {
  id: 'e',
  workspaceId: 'w',
  prId: null,
  kind: 'MONITORING_ENABLED',
  deduplicationKey: 'key',
  payload: {
    kind: 'MONITORING_ENABLED',
    workspaceId: 'w',
    bindingRevision: 1,
    replyToPrComments: false,
  },
  state: 'PENDING',
  attempts: 0,
  deliveryId: 'delivery',
  deliverySessionId: 'main',
  deliveryBindingRevision: 1,
  claimedAt: null,
  deliveredAt: null,
  createdAt: '2026-10-08T00:00:00.000Z',
};
it('limits restored frozen delivery text to 16 KiB in UTF-8 bytes', () => {
  expect(
    prEventBackupSchema.safeParse({ ...frozenEvent, deliveryText: 'x'.repeat(16_384) }).success
  ).toBe(true);
  expect(
    prEventBackupSchema.safeParse({ ...frozenEvent, deliveryText: '🦊'.repeat(4096) }).success
  ).toBe(true);
  expect(prEventBackupSchema.safeParse({ ...frozenEvent, deliveryText: null }).success).toBe(true);
  expect(
    prEventBackupSchema.safeParse({ ...frozenEvent, deliveryText: 'x'.repeat(16_385) }).success
  ).toBe(false);
  expect(
    prEventBackupSchema.safeParse({ ...frozenEvent, deliveryText: '🦊'.repeat(4097) }).success
  ).toBe(false);
});

it('preserves frozen provider identity while accepting older backups without it', () => {
  const oldBackup = { ...frozenEvent, deliveryText: 'frozen' };
  expect(prEventBackupSchema.safeParse(oldBackup).success).toBe(true);
  const identified = {
    ...oldBackup,
    deliveryProvider: 'claude',
    deliveryProviderSessionId: 'original-provider-session',
  };
  expect(prEventBackupSchema.safeParse(identified).success).toBe(true);
  expect(prEventBackupSchema.parse(identified)).toMatchObject({
    deliveryProvider: 'claude',
    deliveryProviderSessionId: 'original-provider-session',
  });
  expect(
    prEventBackupSchema.safeParse({
      ...oldBackup,
      deliveryProvider: null,
      deliveryProviderSessionId: null,
    }).success
  ).toBe(true);
});

it('defaults old monitoring backups to main and preserves dedicated destinations', () => {
  const config = {
    enabled: true,
    recipientSessionId: 'main',
    bindingRevision: 4,
    eventEpoch: 2,
    deliveryPauseReason: null,
    lastCheckedAt: null,
  };
  expect(prMonitoringBackupSchema.parse(config)).toMatchObject({ deliveryMode: 'MAIN' });
  expect(prMonitoringBackupSchema.parse({ ...config, deliveryMode: 'DEDICATED' })).toMatchObject({
    deliveryMode: 'DEDICATED',
    recipientSessionId: 'main',
  });
  expect(prMonitoringBackupSchema.safeParse({ ...config, deliveryMode: 'UNKNOWN' }).success).toBe(
    false
  );
});

it.each(['deliveryId', 'deliverySessionId', 'deliveryBindingRevision', 'deliveryText'] as const)(
  'rejects a dispatching backup without recoverable %s',
  (field) => {
    expect(
      prEventBackupSchema.safeParse({
        ...frozenEvent,
        state: 'DISPATCHING',
        deliveryText: 'frozen',
        [field]: null,
      }).success
    ).toBe(false);
  }
);
it('accepts complete dispatching metadata from older backups without provider fields', () => {
  expect(
    prEventBackupSchema.safeParse({ ...frozenEvent, state: 'DISPATCHING', deliveryText: 'frozen' })
      .success
  ).toBe(true);
});
