import { expect, it } from 'vitest';
import fullJson from '@/shared/testing/recovery-base-json-v8.fixture.json';
import workspaceJson from '@/shared/testing/recovery-base-json-workspace-v8.fixture.json';
import base from '@/shared/testing/recovery-base-v8.fixture.json';
import fixed from '@/shared/testing/recovery-periodic-config-v8.fixture.json';
import { exportDataSchema } from './export-data.schema';

it('preserves the independent periodic literal through client, router and service parsing', () => {
  let parsed = exportDataSchema.parse(fixed);
  for (let i = 0; i < 2; i++) {
    parsed = exportDataSchema.parse(parsed);
  }
  expect(parsed).toEqual(fixed);
});
it.each([
  { cadence: 'MONTHLY', scheduledDayOfMonth: null },
  { cadence: 'DAILY', scheduledDayOfMonth: 31 },
  { cadence: 'WEEKLY', scheduledTime: null, timezone: 'US/Eastern' },
  { cadence: 'EVERY_MINUTE', scheduledTime: '23:59', timezone: null },
  { cadence: 'EVERY_FIVE_MINUTES', scheduledDayOfMonth: 29, timezone: '+01:00' },
  { name: '', prompt: '', id: ' ', scheduledTime: null, timezone: null },
])('accepts independently valid persisted producer fields %j', (fields) => {
  const file = structuredClone(fixed);
  Object.assign(file.data.recovery.periodicConfig.tasks[0]!, fields);
  expect(exportDataSchema.safeParse(file).success).toBe(true);
});
it.each([
  { cadence: 'HOURLY' },
  { scheduledTime: '24:00' },
  { timezone: 'Invalid/Zone' },
  { scheduledDayOfMonth: 0 },
  { scheduledDayOfMonth: 32 },
  { scheduledDayOfMonth: 1.5 },
  { nextRunAt: 'not-a-date' },
  { lastRunAt: '2026-02-30T00:00:00.000Z' },
  { createdAt: '2026-01-01' },
  { updatedAt: null },
  { extra: true },
  { projectId: 'absent' },
  { prompt: undefined },
])('rejects invalid scalar or source ownership %j', (fields) => {
  const file = structuredClone(fixed);
  Object.assign(file.data.recovery.periodicConfig.tasks[0]!, fields);
  expect(exportDataSchema.safeParse(file).success).toBe(false);
});
it('rejects duplicate task identities', () => {
  const file = structuredClone(fixed);
  file.data.recovery.periodicConfig.tasks.push({ ...file.data.recovery.periodicConfig.tasks[0]! });
  expect(exportDataSchema.safeParse(file).success).toBe(false);
});
it.each([undefined, { version: 2, tasks: [] }, { version: 1, tasks: [], extra: true }])(
  'rejects absent or malformed new sections %j',
  (section) => {
    const file = structuredClone(fixed);
    Object.assign(file.data.recovery, { periodicConfig: section });
    expect(exportDataSchema.safeParse(file).success).toBe(false);
    Reflect.deleteProperty(file.data.recovery, 'periodicConfig');
    expect(exportDataSchema.safeParse(file).success).toBe(false);
  }
);
it.each([undefined, 2])('rejects absent or malformed capabilities %j', (capability) => {
  const file = structuredClone(fixed);
  Object.assign(file.meta.recovery.capabilities, { periodicConfig: capability });
  expect(exportDataSchema.safeParse(file).success).toBe(false);
  Reflect.deleteProperty(file.meta.recovery.capabilities, 'periodicConfig');
  expect(exportDataSchema.safeParse(file).success).toBe(false);
});
it.each([base, workspaceJson, fullJson])(
  'keeps old profile $meta.recovery.profile frozen and forbids even own-undefined new fields',
  (original) => {
    expect(exportDataSchema.parse(original).meta).toEqual(original.meta);
    const file = structuredClone(original);
    Object.assign(file.data.recovery, { periodicConfig: undefined });
    expect(exportDataSchema.safeParse(file).success).toBe(false);
    Reflect.deleteProperty(file.data.recovery, 'periodicConfig');
    Object.assign(file.meta.recovery.capabilities, { periodicConfig: undefined });
    expect(exportDataSchema.safeParse(file).success).toBe(false);
  }
);
it('requires baseJson even empty and does not default PR observations under the new full profile', () => {
  const file = structuredClone(fixed);
  Reflect.deleteProperty(file.data.recovery, 'baseJson');
  expect(exportDataSchema.safeParse(file).success).toBe(false);
  const withPR = {
    ...fixed,
    data: {
      ...fixed.data,
      projects: fullJson.data.projects,
      workspaces: structuredClone(fullJson.data.workspaces),
      recovery: { ...fixed.data.recovery, periodicConfig: { version: 1, tasks: [] } },
    },
  };
  expect(exportDataSchema.safeParse(withPR).success).toBe(true);
  Reflect.deleteProperty(withPR.data.workspaces[0]!.prs[0]!, 'observation');
  expect(exportDataSchema.safeParse(withPR).success).toBe(false);
});

it.each([
  [
    'baseJson own undefined capability',
    (file: typeof fixed) => Object.assign(file.meta.recovery.capabilities, { baseJson: undefined }),
  ],
  [
    'missing baseJson capability',
    (file: typeof fixed) => Reflect.deleteProperty(file.meta.recovery.capabilities, 'baseJson'),
  ],
  [
    'baseJson own undefined section',
    (file: typeof fixed) => Object.assign(file.data.recovery, { baseJson: undefined }),
  ],
  [
    'unknown own undefined capability',
    (file: typeof fixed) => Object.assign(file.meta.recovery.capabilities, { extra: undefined }),
  ],
  [
    'unknown own undefined section',
    (file: typeof fixed) => Object.assign(file.data.recovery, { extra: undefined }),
  ],
  [
    'unknown own undefined metadata',
    (file: typeof fixed) => Object.assign(file.meta, { extra: undefined }),
  ],
  [
    'unknown own undefined data',
    (file: typeof fixed) => Object.assign(file.data, { extra: undefined }),
  ],
  [
    'unknown own undefined row',
    (file: typeof fixed) =>
      Object.assign(file.data.recovery.periodicConfig.tasks[0]!, { extra: undefined }),
  ],
] as const)('rejects new-profile %s', (_name, mutate) => {
  const file = structuredClone(fixed);
  mutate(file);
  expect(exportDataSchema.safeParse(file).success).toBe(false);
});
it('requires the periodic section even for an empty task array', () => {
  const file = structuredClone(fixed);
  file.data.recovery.periodicConfig.tasks = [];
  expect(exportDataSchema.safeParse(file).success).toBe(true);
  Reflect.deleteProperty(file.data.recovery, 'periodicConfig');
  expect(exportDataSchema.safeParse(file).success).toBe(false);
});
