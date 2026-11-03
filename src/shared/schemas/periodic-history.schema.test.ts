import { expect, it } from 'vitest';
import fixed from '@/shared/testing/recovery-periodic-history-v8.fixture.json';
import { exportDataSchema } from './export-data.schema';

it('preserves independently specified inert periodic history through repeated parses', () => {
  let parsed = exportDataSchema.parse(fixed);
  for (let i = 0; i < 2; i++) {
    parsed = exportDataSchema.parse(parsed);
  }
  expect(parsed).toEqual(fixed);
});
it.each([
  { periodicTaskId: 'missing' },
  { workspaceId: 'missing' },
  { launchSnapshot: {} },
  { startedAt: undefined },
  { status: 'UNKNOWN' },
  { prNumber: 1.5 },
  { extra: undefined },
])('rejects malformed history or missing file owners %j', (fields) => {
  const file = structuredClone(fixed);
  Object.assign(file.data.recovery.periodicHistory.executions[0]!, fields);
  expect(exportDataSchema.safeParse(file).success).toBe(false);
});
it('requires history even when empty', () => {
  const file = structuredClone(fixed);
  file.data.recovery.periodicHistory.executions = [];
  expect(exportDataSchema.safeParse(file).success).toBe(true);
  Reflect.deleteProperty(file.data.recovery, 'periodicHistory');
  expect(exportDataSchema.safeParse(file).success).toBe(false);
});

it.each([
  [
    'duplicate ID',
    (f: typeof fixed) =>
      f.data.recovery.periodicHistory.executions.push({
        ...f.data.recovery.periodicHistory.executions[0]!,
      }),
  ],
  [
    'unknown marker',
    (f: typeof fixed) =>
      Object.assign(f.data.recovery.periodicHistory, {
        jsonStorage: [{ model: 'Workspace', identity: ['x'], field: 'creationMetadata' }],
      }),
  ],
  [
    'dangling marker',
    (f: typeof fixed) =>
      Object.assign(f.data.recovery.periodicHistory, {
        jsonStorage: [{ model: 'PeriodicTaskExecution', identity: ['x'], field: 'launchSnapshot' }],
      }),
  ],
  [
    'undefined capability',
    (f: typeof fixed) =>
      Object.assign(f.meta.recovery.capabilities, { periodicHistory: undefined }),
  ],
  [
    'wrong project snapshot',
    (f: typeof fixed) =>
      Object.assign(f.data.recovery.periodicHistory.executions[0]!, {
        launchSnapshot: {
          version: 1,
          projectId: 'wrong',
          name: '',
          prompt: '',
          cadence: 'DAILY',
          scheduledTime: null,
          timezone: null,
          scheduledDayOfMonth: null,
          dueAt: '2026-01-01T00:00:00.000Z',
        },
      }),
  ],
] as const)('rejects %s', (_label, mutate) => {
  const file = structuredClone(fixed);
  mutate(file);
  expect(exportDataSchema.safeParse(file).success).toBe(false);
});
it('preserves canonical snapshot calendars independently of current task validation', () => {
  const file = structuredClone(fixed);
  Object.assign(file.data.recovery.periodicHistory.executions[0]!, {
    launchSnapshot: {
      version: 1,
      projectId: file.data.recovery.periodicConfig.tasks[0]!.projectId,
      name: '',
      prompt: 'old',
      cadence: 'DAILY',
      scheduledTime: 'legacy clock',
      timezone: 'legacy zone',
      scheduledDayOfMonth: -10,
      dueAt: '2026-01-01T00:00:00.000Z',
    },
  });
  expect(exportDataSchema.parse(file)).toEqual(file);
});
