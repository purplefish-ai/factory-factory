import { expect, it } from 'vitest';
import fixed from '@/shared/testing/recovery-base-json-workspace-v8.fixture.json';
import { malformedWorkspaceJsonCases } from '@/shared/testing/recovery-json-storage.fixture';
import { exportDataSchema } from './export-data.schema';

it('accepts the independently frozen workspace profile through three parses', () => {
  let parsed = exportDataSchema.parse(fixed);
  for (let i = 0; i < 2; i++) {
    parsed = exportDataSchema.parse(parsed);
  }
  expect(parsed.meta).toEqual(fixed.meta);
  expect(parsed.data).toHaveProperty('recovery', fixed.data.recovery);
});
it('accepts an explicit empty section and ordinary nested JSON', () => {
  const file = structuredClone(fixed);
  file.data.recovery.baseJson.jsonStorage = [];
  Object.assign(file.data.workspaces[0]!, { creationMetadata: { nested: null } });
  expect(exportDataSchema.safeParse(file).success).toBe(true);
});
it('accepts empty and reserved/delimiter workspace identities', () => {
  for (const id of ['', '__proto__', 'a|b']) {
    const file = structuredClone(fixed);
    file.data.workspaces[0]!.id = id;
    file.data.workspaces[1]!.parentWorkspaceId = id;
    file.data.agentSessions[0]!.workspaceId = id;
    file.data.terminalSessions[0]!.workspaceId = id;
    file.data.recovery.baseJson.jsonStorage[0]!.identity = [id];
    expect(exportDataSchema.safeParse(file).success).toBe(true);
  }
});
it.each(malformedWorkspaceJsonCases)('rejects %s', (_name, mutate) => {
  const file = structuredClone(fixed);
  mutate(file);
  expect(exportDataSchema.safeParse(file).success).toBe(false);
});

it('locates covered field and marker failures within the whole backup', () => {
  const file = structuredClone(fixed);
  Object.assign(file.data.workspaces[0]!, { creationMetadata: undefined });
  file.data.recovery.baseJson.jsonStorage[0]!.identity = ['missing'];
  const result = exportDataSchema.safeParse(file);
  expect(result.success).toBe(false);
  if (result.success) {
    throw new Error('Expected invalid backup');
  }
  expect(result.error.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        message: 'Covered creationMetadata must be present',
        path: ['data', 'workspaces', 0, 'creationMetadata'],
      }),
      expect.objectContaining({
        message: 'Invalid Workspace JSON-null target',
        path: ['data', 'recovery', 'baseJson', 'jsonStorage', 0, 'identity'],
      }),
    ])
  );
});
