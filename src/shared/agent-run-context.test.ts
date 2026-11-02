import { expect, it } from 'vitest';
import { storedAgentRunContextSchema } from './agent-run-context';
import { agentDefinitionInputSchema, agentRunInputSchema } from './schemas/agent-definition.schema';

const expiredAt = '2026-11-02T00:00:00.000Z';
const expired = { version: 1, state: 'EXPIRED', expiredAt };
const row = {
  contextExpiredAt: expiredAt,
  definitionSnapshot: expired,
  triggerSnapshot: expired,
  input: expired,
};
it('round-trips expired stored context while executable launch schemas reject it', () => {
  expect(storedAgentRunContextSchema.parse(JSON.parse(JSON.stringify(row)))).toEqual(row);
  expect(agentDefinitionInputSchema.safeParse(expired).success).toBe(false);
  expect(agentRunInputSchema.safeParse(expired).success).toBe(false);
});
it('rejects partially expired, invalid and mismatched stored representations', () => {
  for (const invalid of [
    { ...row, contextExpiredAt: null },
    { ...row, input: {} },
    { ...row, triggerSnapshot: null },
    { ...row, definitionSnapshot: { ...expired, expiredAt: '2026-11-03T00:00:00.000Z' } },
  ]) {
    expect(storedAgentRunContextSchema.safeParse(invalid).success).toBe(false);
  }
});
it('retains complete legacy snapshots without a rewrite', () => {
  const retained = {
    contextExpiredAt: null,
    definitionSnapshot: {
      name: 'Task',
      instructions: 'Task instructions',
      isEnabled: true,
      executionConfig: { version: 1 },
    },
    triggerSnapshot: null,
    input: { version: 1, context: [] },
  };
  expect(storedAgentRunContextSchema.parse(retained)).toEqual(retained);
});

it.each(['definitionSnapshot', 'triggerSnapshot', 'input'] as const)(
  'rejects a stale expired timestamp in %s',
  (field) => {
    expect(
      storedAgentRunContextSchema.safeParse({
        ...row,
        [field]: { ...expired, expiredAt: '2026-11-03T00:00:00.000Z' },
      }).success
    ).toBe(false);
  }
);

it('validates an expired context projection from a complete run record', () => {
  expect(
    storedAgentRunContextSchema.parse({
      ...row,
      id: 'run',
      status: 'COMPLETED',
      result: { version: 1, summary: '', pullRequests: [] },
    })
  ).toEqual(row);
  expect(
    storedAgentRunContextSchema.safeParse({
      ...row,
      input: { ...expired, unexpectedSensitiveText: 'Not permitted inside snapshots' },
    }).success
  ).toBe(false);
});
