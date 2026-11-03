import { expect, it, vi } from 'vitest';
import { automationDefinitionsRecoverySchema } from '@/shared/schemas/automation-definitions-recovery.schema';
import fixed from '@/shared/testing/recovery-automation-definitions-v8.fixture.json';
import type { Prisma } from '@prisma-gen/client';
import {
  exportAutomationDefinitionsRecovery,
  planAutomationDefinitionsRecovery,
  restoreAutomationDefinitionsRecovery,
} from './agent-definition-recovery';

const section = () =>
  automationDefinitionsRecoverySchema.parse(fixed.data.recovery.automationDefinitions);

it('plans all rows from one unfiltered occupancy read before any insert with exclusive identity priority', async () => {
  const create = vi.fn().mockResolvedValue({});
  const findMany = vi.fn(() => {
    expect(create).not.toHaveBeenCalled();
    return Promise.resolve(Array.from({ length: 1002 }, (_, i) => ({ id: `local-${i}` })));
  });
  const tx = { agentDefinition: { findMany, create } } as unknown as Prisma.TransactionClient;
  const input = section();
  const row = input.definitions[0]!;
  input.definitions = [
    { ...row, id: 'local-1001', projectId: 'unavailable' },
    { ...row, id: 'missing', projectId: 'unavailable' },
    { ...row, id: 'healthy' },
    { ...row, id: 'same-name' },
  ];
  const plan = await planAutomationDefinitionsRecovery(tx, input, new Set([row.projectId]));
  expect(findMany).toHaveBeenCalledExactlyOnceWith({ select: { id: true } });
  expect(create).not.toHaveBeenCalled();
  expect(plan.map(({ reason }) => reason)).toEqual([
    'EXISTING_IDENTITY',
    'INCOMPLETE_DEPENDENCY',
    null,
    null,
  ]);
  expect(await restoreAutomationDefinitionsRecovery(tx, plan, new Set([row.projectId]))).toEqual({
    model: 'AgentDefinition',
    imported: 2,
    skipped: 2,
    sourceEnabled: 4,
    restoredDisabled: 2,
    reasons: { EXISTING_IDENTITY: 1, INCOMPLETE_DEPENDENCY: 1 },
  });
  expect(create).toHaveBeenCalledTimes(2);
  expect(create).toHaveBeenNthCalledWith(1, {
    data: {
      ...input.definitions[2],
      isEnabled: false,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
    },
  });
});

it.each(['EXISTING_IDENTITY', 'INCOMPLETE_DEPENDENCY', null] as const)(
  'checks actual parents even for a row skipped as %s',
  async (reason) => {
    const create = vi.fn();
    const tx = { agentDefinition: { create } } as unknown as Prisma.TransactionClient;
    await expect(
      restoreAutomationDefinitionsRecovery(
        tx,
        [
          {
            row: section().definitions[0]!,
            dependenciesAvailable: true,
            reason,
          },
        ],
        new Set()
      )
    ).rejects.toThrow('Automation definition dependencies disagree with admission');
    expect(create).not.toHaveBeenCalled();
  }
);

it('propagates insertion failure rather than claiming a skip', async () => {
  const failure = new Error('intended definition insert failure');
  const tx = {
    agentDefinition: { create: vi.fn().mockRejectedValue(failure) },
  } as unknown as Prisma.TransactionClient;
  const row = section().definitions[0]!;
  await expect(
    restoreAutomationDefinitionsRecovery(
      tx,
      [
        {
          row,
          dependenciesAvailable: true,
          reason: null,
        },
      ],
      new Set([row.projectId])
    )
  ).rejects.toBe(failure);
});

it('exports only ten explicit scalars in ID order and visibly rejects unsupported stored config', async () => {
  const row = section().definitions[0]!;
  const stored = { ...row, createdAt: new Date(row.createdAt), updatedAt: new Date(row.updatedAt) };
  const findMany = vi.fn().mockResolvedValue([stored]);
  const tx = { agentDefinition: { findMany } } as unknown as Prisma.TransactionClient;
  expect(await exportAutomationDefinitionsRecovery(tx)).toEqual(section());
  expect(findMany).toHaveBeenCalledExactlyOnceWith({
    orderBy: { id: 'asc' },
    select: {
      id: true,
      projectId: true,
      name: true,
      instructions: true,
      isEnabled: true,
      executionConfig: true,
      definitionRevision: true,
      managementRevision: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  findMany.mockResolvedValue([{ ...stored, executionConfig: { version: 1, token: 'secret' } }]);
  await expect(exportAutomationDefinitionsRecovery(tx)).rejects.toThrow('Unrecognized key');
});

it('returns truthful empty counts after an empty unfiltered plan', async () => {
  const create = vi.fn();
  const tx = {
    agentDefinition: { findMany: vi.fn().mockResolvedValue([]), create },
  } as unknown as Prisma.TransactionClient;
  const plan = await planAutomationDefinitionsRecovery(
    tx,
    { version: 1, definitions: [] },
    new Set()
  );
  expect(await restoreAutomationDefinitionsRecovery(tx, plan, new Set())).toEqual({
    model: 'AgentDefinition',
    imported: 0,
    skipped: 0,
    sourceEnabled: 0,
    restoredDisabled: 0,
    reasons: { EXISTING_IDENTITY: 0, INCOMPLETE_DEPENDENCY: 0 },
  });
  expect(create).not.toHaveBeenCalled();
});
