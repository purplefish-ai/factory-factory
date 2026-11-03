import { expect, it } from 'vitest';
import full from '@/shared/testing/recovery-base-json-v8.fixture.json';
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

it('accepts the independent full catalog with explicit PR observations through three parses', () => {
  let parsed = exportDataSchema.parse(full);
  for (let i = 0; i < 2; i++) {
    parsed = exportDataSchema.parse(parsed);
  }
  expect(parsed.meta).toEqual(full.meta);
});

it.each(['missing', 'undefined'])(
  'rejects %s full-profile observation without borrowing the old default',
  (kind) => {
    const file = structuredClone(full);
    const pr = file.data.workspaces[0]!.prs[0]!;
    if (kind === 'missing') {
      Reflect.deleteProperty(pr, 'observation');
    } else {
      Object.assign(pr, { observation: undefined });
    }
    file.data.recovery.baseJson.jsonStorage = [];
    expect(exportDataSchema.safeParse(file).success).toBe(false);
  }
);
it('keeps same text identities distinct across the three catalog models', () => {
  const file = structuredClone(full);
  const id = file.data.workspaces[0]!.id;
  const pr = file.data.workspaces[0]!.prs[0]!;
  pr.id = id;
  const session = file.data.agentSessions[0]!;
  session.id = id;
  Object.assign(session, { workspacePrId: null });
  Object.assign(file.data.recovery.baseJson, {
    jsonStorage: [
      { model: 'Workspace', identity: [id], field: 'creationMetadata' },
      { model: 'WorkspacePR', identity: [id], field: 'observation' },
      { model: 'AgentSession', identity: [id], field: 'providerMetadata' },
    ],
  });
  expect(exportDataSchema.safeParse(file).success).toBe(true);
});
it('rejects PR and session markers in the historical workspace catalog', () => {
  for (const marker of [
    {
      model: 'WorkspacePR',
      identity: [fixed.data.workspaces[0]!.prs[0]!.id],
      field: 'observation',
    },
    {
      model: 'AgentSession',
      identity: [fixed.data.agentSessions[0]!.id],
      field: 'providerMetadata',
    },
  ]) {
    const file = structuredClone(fixed);
    Object.assign(file.data.recovery.baseJson, { jsonStorage: [marker] });
    expect(exportDataSchema.safeParse(file).success).toBe(false);
  }
});

it.each([
  [
    'undefined workspace field',
    (file: typeof full) => Object.assign(file.data.workspaces[0]!, { creationMetadata: undefined }),
  ],
  [
    'undefined session field',
    (file: typeof full) =>
      Object.assign(file.data.agentSessions[0]!, { providerMetadata: undefined }),
  ],
  [
    'unknown meta undefined',
    (file: typeof full) => Object.assign(file.meta, { unsupported: undefined }),
  ],
  [
    'unknown data undefined',
    (file: typeof full) => Object.assign(file.data, { unsupported: undefined }),
  ],
  [
    'missing capability',
    (file: typeof full) => Reflect.deleteProperty(file.meta.recovery.capabilities, 'baseJson'),
  ],
  [
    'undefined section',
    (file: typeof full) => Object.assign(file.data.recovery, { baseJson: undefined }),
  ],
  [
    'duplicate marker',
    (file: typeof full) =>
      file.data.recovery.baseJson.jsonStorage.push(file.data.recovery.baseJson.jsonStorage[0]!),
  ],
  [
    'missing marker target',
    (file: typeof full) =>
      file.data.recovery.baseJson.jsonStorage[0]!.identity.splice(0, 1, 'absent'),
  ],
  [
    'non-null marker target',
    (file: typeof full) =>
      Object.assign(file.data.workspaces[0]!, { creationMetadata: { nested: null } }),
  ],
  [
    'empty PR marker identity',
    (file: typeof full) =>
      Object.assign(file.data.recovery.baseJson, {
        jsonStorage: [{ model: 'WorkspacePR', identity: [''], field: 'observation' }],
      }),
  ],
  [
    'wrong model/field pairing',
    (file: typeof full) =>
      Object.assign(file.data.recovery.baseJson.jsonStorage[0]!, { model: 'AgentSession' }),
  ],
  [
    'wrong arity',
    (file: typeof full) => file.data.recovery.baseJson.jsonStorage[0]!.identity.push('extra'),
  ],
] as const)('rejects full-profile %s before normalization', (_name, mutate) => {
  const file = structuredClone(full);
  mutate(file);
  expect(exportDataSchema.safeParse(file).success).toBe(false);
});
