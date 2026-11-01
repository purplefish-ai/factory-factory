import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import type { AgentClaimResult } from '@/shared/agent-runtime';
import type { EventAgentExecution } from '@/shared/event-agent-launch';
import { createLedgerFixture } from './testing/agent-ledger.test-support';
let db: IntegrationDatabase;
let runtime: typeof import('../index');
let fixture: Awaited<ReturnType<typeof createLedgerFixture>>;
const execution: EventAgentExecution = {
  version: 1,
  provider: 'CLAUDE',
  model: 'sonnet',
  reasoningEffort: null,
  codexAccountId: null,
  startupModePreset: 'non_interactive',
  accessMode: 'bypassPermissions',
  planModeEnabled: false,
};
beforeAll(async () => {
  db = await createIntegrationDatabase();
  runtime = await vi.importActual<typeof import('../index')>('../index');
  expect(runtime.freezeEventExecution).toBeTypeOf('function');
}, 30_000);
beforeEach(async () => {
  fixture = await createLedgerFixture(db, runtime);
});
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});
async function claimed(
  config = { version: 1 as const, provider: execution.provider, model: execution.model }
) {
  const admitted = await fixture.admit(await fixture.event(), { executionConfig: config });
  expect(admitted.status).toBe('ADMITTED');
  const claim = await runtime.claimNextRun();
  if (claim.status !== 'CLAIMED') {
    throw new Error(JSON.stringify(claim));
  }
  const delivery = await db.prisma.agentInitialDelivery.findUniqueOrThrow({
    where: { runId: claim.runId },
  });
  return { claim, sendAttemptId: delivery.sendAttemptId, messageId: delivery.messageId, execution };
}
it('freezes once under concurrent attempts without changing admitted snapshots', async () => {
  const input = await claimed();
  const before = await db.prisma.agentRun.findUniqueOrThrow({ where: { id: input.claim.runId } });
  const results = await Promise.all([
    runtime.freezeEventExecution(input),
    runtime.freezeEventExecution(input),
  ]);
  expect(results).toEqual([execution, execution]);
  expect(await runtime.readEventExecutionBinding(input.claim)).toEqual({
    execution,
    sendAttemptId: input.sendAttemptId,
    messageId: input.messageId,
  });
  const after = await db.prisma.agentRun.findUniqueOrThrow({ where: { id: input.claim.runId } });
  expect(after.definitionSnapshot).toEqual(before.definitionSnapshot);
  expect(after.input).toEqual(before.input);
  expect(after.triggerSnapshot).toEqual(before.triggerSnapshot);
});
it('retains the frozen account across a crash before session creation and rejects replacement', async () => {
  const input = await claimed({ version: 1, provider: 'CODEX', model: 'gpt-5.4' });
  const selected: EventAgentExecution = {
    ...execution,
    provider: 'CODEX',
    model: 'gpt-5.4',
    codexAccountId: 'account-A',
    accessMode: 'workspace-write',
  };
  await runtime.freezeEventExecution({ ...input, execution: selected });
  await db.prisma.agentRun.update({
    where: { id: input.claim.runId },
    data: { workerGeneration: { increment: 1 } },
  });
  const next = {
    ...input,
    claim: { ...input.claim, workerGeneration: input.claim.workerGeneration + 1 },
    execution: selected,
  };
  expect(await runtime.readEventExecutionBinding(next.claim)).toMatchObject({
    execution: { codexAccountId: 'account-A' },
  });
  await expect(
    runtime.freezeEventExecution({
      ...next,
      execution: { ...selected, codexAccountId: 'account-B' },
    })
  ).rejects.toThrow(/frozen/i);
  expect(await runtime.freezeEventExecution(next)).toEqual(selected);
});
it.each([
  'workerGeneration',
  'attemptGeneration',
  'reservedWorkspaceId',
  'reservedSessionId',
  'initialMessageId',
] as const)('rejects stale or foreign %s before writing a binding', async (key) => {
  const input = await claimed();
  const claim: Extract<AgentClaimResult, { status: 'CLAIMED' }> = { ...input.claim };
  if (key === 'workerGeneration' || key === 'attemptGeneration') {
    claim[key] += 1;
  } else {
    claim[key] = 'foreign';
  }
  await expect(runtime.freezeEventExecution({ ...input, claim })).rejects.toThrow(/claim/i);
  expect((await runtime.readEventExecutionBinding(input.claim)).execution).toBeNull();
});
it('rejects a different pending send identity and expired lease', async () => {
  const input = await claimed();
  await expect(runtime.freezeEventExecution({ ...input, sendAttemptId: 'old' })).rejects.toThrow(
    /attempt/i
  );
  await db.prisma.agentRun.update({
    where: { id: input.claim.runId },
    data: { leaseExpiresAt: new Date(0) },
  });
  await expect(runtime.freezeEventExecution(input)).rejects.toThrow(/claim/i);
});
it.each(['SENDING', 'ACCEPTED', 'AMBIGUOUS', 'FINISHED'] as const)(
  'cannot freeze or rebind a %s delivery',
  async (state) => {
    const input = await claimed();
    await db.prisma.agentInitialDelivery.update({
      where: { runId: input.claim.runId },
      data: { state },
    });
    await expect(runtime.freezeEventExecution(input)).rejects.toThrow(/pending/i);
  }
);
it.each([{ model: 'opus' }, { reasoningEffort: 'high' }])(
  'cannot override admitted execution %j',
  async (patch) => {
    const input = await claimed();
    await expect(
      runtime.freezeEventExecution({ ...input, execution: { ...execution, ...patch } })
    ).rejects.toThrow(/admitted/i);
  }
);
it('claimed work retains admitted settings after authoring edits', async () => {
  const input = await claimed();
  await db.prisma.agentDefinition.update({
    where: { id: fixture.definitionId },
    data: {
      instructions: 'Changed',
      definitionRevision: 2,
      executionConfig: { version: 1, provider: 'CODEX', model: 'gpt-5.4' },
    },
  });
  expect(await runtime.freezeEventExecution(input)).toEqual(execution);
});
it('rejects non-running runs and corrupt saved binding without replacing data', async () => {
  const input = await claimed();
  await db.prisma.agentRun.update({
    where: { id: input.claim.runId },
    data: { effectiveExecution: { version: 999 } },
  });
  await expect(runtime.freezeEventExecution(input)).rejects.toMatchObject({ name: 'ZodError' });
  expect(
    (await db.prisma.agentRun.findUniqueOrThrow({ where: { id: input.claim.runId } }))
      .effectiveExecution
  ).toEqual({ version: 999 });
  await db.prisma.agentRun.update({ where: { id: input.claim.runId }, data: { status: 'FAILED' } });
  await expect(runtime.freezeEventExecution(input)).rejects.toThrow(/claim/i);
});

it('reuses frozen binding after a new pending attempt rotates delivery identity but not reserved IDs', async () => {
  const input = await claimed();
  await runtime.freezeEventExecution(input);
  await db.prisma.agentRun.update({
    where: { id: input.claim.runId },
    data: { attemptGeneration: 2, workerGeneration: 2 },
  });
  await db.prisma.agentInitialDelivery.update({
    where: { runId: input.claim.runId },
    data: { attemptGeneration: 2, sendAttemptId: 'retry-attempt', messageId: 'retry-message' },
  });
  const next = {
    ...input,
    claim: { ...input.claim, attemptGeneration: 2, workerGeneration: 2 },
    sendAttemptId: 'retry-attempt',
    messageId: 'retry-message',
  };
  expect(await runtime.readEventExecutionBinding(next.claim)).toEqual({
    execution,
    sendAttemptId: 'retry-attempt',
    messageId: 'retry-message',
  });
  await expect(
    runtime.freezeEventExecution({ ...next, messageId: input.messageId })
  ).rejects.toThrow(/attempt/i);
  expect(await runtime.freezeEventExecution(next)).toEqual(execution);
  await expect(runtime.freezeEventExecution(input)).rejects.toThrow(/claim/i);
});

it('allows only one of concurrent conflicting account bindings to commit', async () => {
  const input = await claimed({ version: 1, provider: 'CODEX', model: 'gpt-5.4' });
  const selected: EventAgentExecution = {
    ...execution,
    provider: 'CODEX',
    model: 'gpt-5.4',
    codexAccountId: 'first',
    accessMode: 'workspace-write',
  };
  const results = await Promise.allSettled([
    runtime.freezeEventExecution({ ...input, execution: selected }),
    runtime.freezeEventExecution({
      ...input,
      execution: { ...selected, codexAccountId: 'second' },
    }),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  expect((await runtime.readEventExecutionBinding(input.claim)).execution?.codexAccountId).toMatch(
    /^(first|second)$/
  );
});
it('preserves explicitly admitted effort when freezing effective settings', async () => {
  const id = await fixture.event();
  await fixture.admit(id, {
    executionConfig: { version: 1, provider: 'CLAUDE', model: 'sonnet', reasoningEffort: 'high' },
  });
  const claim = await runtime.claimNextRun();
  if (claim.status !== 'CLAIMED') {
    throw new Error('Expected claim');
  }
  const binding = await runtime.readEventExecutionBinding(claim);
  await expect(runtime.freezeEventExecution({ claim, ...binding, execution })).rejects.toThrow(
    /admitted/i
  );
  expect(
    await runtime.freezeEventExecution({
      claim,
      ...binding,
      execution: { ...execution, reasoningEffort: 'high' },
    })
  ).toMatchObject({ reasoningEffort: 'high' });
});
