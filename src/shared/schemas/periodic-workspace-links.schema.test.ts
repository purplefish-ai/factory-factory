import { expect, it } from 'vitest';
import old from '@/shared/testing/recovery-periodic-config-v8.fixture.json';
import links from '@/shared/testing/recovery-periodic-links-v8.fixture.json';
import { exportDataSchema } from './export-data.schema';

it('preserves the independent linked-workspace literal through three schema roundtrips', () => {
  let parsed = exportDataSchema.parse(links);
  for (let i = 0; i < 2; i++) {
    parsed = exportDataSchema.parse(parsed);
  }
  expect(parsed).toEqual(links);
});
it.each(['missing', 'undefined'])('requires the new workspace own link field: %s', (kind) => {
  const file = structuredClone(links);
  if (kind === 'missing') {
    Reflect.deleteProperty(file.data.workspaces[0]!, 'periodicTaskId');
  } else {
    Object.assign(file.data.workspaces[0]!, { periodicTaskId: undefined });
  }
  expect(exportDataSchema.safeParse(file).success).toBe(false);
});
it('accepts explicit null without inferring periodic creation history', () => {
  const file = structuredClone(links);
  Object.assign(file.data.workspaces[0]!, {
    periodicTaskId: null,
    creationSource: 'PERIODIC_TASK',
  });
  expect(exportDataSchema.parse(file).data.workspaces[0]).toHaveProperty('periodicTaskId', null);
});
it('locates a missing file-owned task at the second workspace index', () => {
  const file = structuredClone(links);
  file.data.workspaces[1]!.periodicTaskId = 'absent';
  const result = exportDataSchema.safeParse(file);
  expect(result.success).toBe(false);
  if (result.success) {
    throw new Error('Expected absent task rejection');
  }
  const issues = result.error.issues.flatMap((issue) =>
    issue.code === 'invalid_union' ? issue.errors.flat() : [issue]
  );
  expect(issues).toContainEqual({
    code: 'custom',
    message: 'Workspace periodic task is absent from backup',
    path: ['data', 'workspaces', 1, 'periodicTaskId'],
  });
});
it('keeps the earlier profile workspace stripping contract', () => {
  const file = { ...old, data: { ...links.data, recovery: old.data.recovery } };
  expect(exportDataSchema.parse(file).data.workspaces[0]).not.toHaveProperty('periodicTaskId');
});
it.each(['baseJson', 'periodicConfig'] as const)(
  'requires unchanged section and capability %s',
  (key) => {
    const file = structuredClone(links);
    Reflect.deleteProperty(file.data.recovery, key);
    expect(exportDataSchema.safeParse(file).success).toBe(false);
    const capability = structuredClone(links);
    Object.assign(capability.meta.recovery.capabilities, { [key]: undefined });
    expect(exportDataSchema.safeParse(capability).success).toBe(false);
  }
);
it.each(['missing', 'undefined'])(
  'requires full-profile PR observation with an empty catalog: %s',
  (kind) => {
    const file = structuredClone(links);
    file.data.recovery.baseJson.jsonStorage = [];
    const pr = file.data.workspaces[0]!.prs[0]!;
    if (kind === 'missing') {
      Reflect.deleteProperty(pr, 'observation');
    } else {
      Object.assign(pr, { observation: undefined });
    }
    expect(exportDataSchema.safeParse(file).success).toBe(false);
  }
);
