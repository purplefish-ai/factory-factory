import { expect, it } from 'vitest';
import fixture from '@/shared/testing/recovery-slack-connections-v8.fixture.json';
import { exportDataSchema } from './export-data.schema';
import { slackConnectionsRecoverySchema } from './slack-connections-recovery.schema';

const section = () => structuredClone(fixture.data.recovery.slackConnections);
it('preserves raw padded, whitespace and reserved identities without normalization', () => {
  const input = section();
  input.connections[0] = { ...input.connections[0]!, id: '__proto__', externalId: '  ', name: ' ' };
  input.connections[1] = {
    ...input.connections[1]!,
    id: '',
    externalId: ' T:one ',
    name: ' padded ',
  };
  expect(slackConnectionsRecoverySchema.parse(input)).toEqual(input);
});
it.each(['id', 'externalId'] as const)(
  'rejects duplicate %s at its exact indexed path',
  (field) => {
    const input = section();
    input.connections[1]![field] = input.connections[0]![field];
    const result = slackConnectionsRecoverySchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['connections', 1, field]);
    }
  }
);
it.each([
  { provider: 'GITHUB' },
  { externalId: '' },
  { name: '' },
  { createdAt: 'yesterday' },
  { updatedAt: '2026-11-02' },
  { credentialsEncrypted: 'cipher' },
  { botToken: undefined },
])('rejects malformed and unknown row properties %j', (patch) => {
  const input = section();
  Object.assign(input.connections[0]!, patch);
  expect(slackConnectionsRecoverySchema.safeParse(input).success).toBe(false);
});
it('rejects unknown section properties even when undefined', () => {
  expect(slackConnectionsRecoverySchema.safeParse({ ...section(), token: undefined }).success).toBe(
    false
  );
});
it('requires all five sections and accepts their empty forms', () => {
  const input = structuredClone(fixture);
  input.data.projects = [];
  input.data.workspaces = [];
  input.data.agentSessions = [];
  input.data.terminalSessions = [];
  input.data.codexAccounts = [];
  input.data.recovery = {
    baseJson: { version: 1, jsonStorage: [] },
    periodicConfig: { version: 1, tasks: [] },
    periodicHistory: { version: 1, executions: [], jsonStorage: [] },
    automationDefinitions: { version: 1, definitions: [] },
    slackConnections: { version: 1, connections: [] },
  };
  expect(exportDataSchema.safeParse(input).success).toBe(true);
  for (const key of Object.keys(input.data.recovery)) {
    const raw = structuredClone(input);
    Reflect.deleteProperty(raw.data.recovery, key);
    expect(exportDataSchema.safeParse(raw).success, key).toBe(false);
  }
});
it('requires the exact five capabilities and rejects unknown or wrong values', () => {
  for (const key of Object.keys(fixture.meta.recovery.capabilities)) {
    const missing = structuredClone(fixture);
    Reflect.deleteProperty(missing.meta.recovery.capabilities, key);
    expect(exportDataSchema.safeParse(missing).success, key).toBe(false);
    const wrong = structuredClone(fixture);
    Reflect.set(wrong.meta.recovery.capabilities, key, 2);
    expect(exportDataSchema.safeParse(wrong).success, key).toBe(false);
  }
  const unknown = structuredClone(fixture);
  Reflect.set(unknown.meta.recovery.capabilities, 'credentials', undefined);
  expect(exportDataSchema.safeParse(unknown).success).toBe(false);
});
