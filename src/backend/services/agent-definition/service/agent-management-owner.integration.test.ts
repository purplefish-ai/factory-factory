import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createLedgerFixture } from '@/backend/services/agent-definition/resources/testing/agent-ledger.test-support';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';

let db: IntegrationDatabase;
let runtime: typeof import('@/backend/services/agent-definition');
let workspace: typeof import('@/backend/services/workspace');
let fixture: Awaited<ReturnType<typeof createLedgerFixture>>;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let gate:
  | {
      winner: 'saved' | 'proposal';
      locked: boolean;
      acquired: ReturnType<typeof deferred>;
      requested: ReturnType<typeof deferred>;
      release: ReturnType<typeof deferred>;
    }
  | undefined;
beforeAll(async () => {
  db = await createIntegrationDatabase();
  const observed = db.prisma.$extends({
    query: {
      $allOperations: async ({ model, operation, args, query }) => {
        const active = gate;
        const write =
          operation === '$executeRaw'
            ? 'saved'
            : model === 'AgentProposal' && operation === 'updateMany'
              ? 'proposal'
              : null;
        const result = await query(args);
        if (active && write === active.winner && !active.locked) {
          active.locked = true;
          active.acquired.resolve();
          await active.release.promise;
        }
        return result;
      },
    },
  });
  const queued = new Proxy(observed, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property !== '$transaction') {
        return value;
      }
      return (...args: unknown[]) => {
        const result = Reflect.apply(value, target, args);
        if (gate?.locked) {
          gate.requested.resolve();
        }
        return result;
      };
    },
  });
  vi.doMock('@/backend/db', () => ({ prisma: queued }));
  runtime = await vi.importActual<typeof import('@/backend/services/agent-definition')>(
    '@/backend/services/agent-definition'
  );
  workspace = await vi.importActual<typeof import('@/backend/services/workspace')>(
    '@/backend/services/workspace'
  );
  const { captureWorkspaceRunResults } = await vi.importActual<
    typeof import('@/backend/orchestration/workspace-deletion.orchestrator')
  >('@/backend/orchestration/workspace-deletion.orchestrator');
  workspace.workspaceDataService.configureDeletionCapture(captureWorkspaceRunResults);
}, 30_000);
afterAll(async () => {
  vi.doUnmock('@/backend/db');
  await destroyIntegrationDatabase(db);
});
beforeEach(async () => {
  fixture = await createLedgerFixture(db, runtime);
});

async function author() {
  const definition = await db.prisma.agentDefinition.findUniqueOrThrow({
    where: { id: fixture.definitionId },
  });
  const authoring = await db.prisma.workspace.create({
    data: { projectId: definition.projectId, name: 'Author' },
  });
  const service = new runtime.AgentProposalService();
  const proposal = await service.propose({
    workspaceId: authoring.id,
    specification: {
      name: 'Saved agent',
      instructions: 'Original task',
      executionConfig: { version: 1, provider: 'CLAUDE', model: 'sonnet' },
      triggers: ['first', 'second'].map((id) => ({
        id,
        type: 'GITHUB_ISSUE',
        connectionId: fixture.connectionId,
        description: id,
        config: { version: 1, repositoryIds: ['repo-1'], actions: ['labeled'] },
      })),
    },
  });
  const accepted = await service.create({
    workspaceId: authoring.id,
    proposalId: proposal.id,
    revision: proposal.revision,
    specification: proposal.specification,
  });
  const agentId = accepted.agentDefinitionId!;
  const input = { projectId: definition.projectId, agentId };
  const evidence = {
    project: { id: definition.projectId, githubOwner: 'org', githubRepo: 'repo' },
    connections: [
      { id: fixture.connectionId, provider: 'GITHUB' as const, externalId: 'gh:repo-1' },
    ],
    sourceNames: {},
  };
  return { service, proposal: accepted, authoring, input, evidence };
}

it('keeps the exact saved set after real proposal removal and public workspace deletion', async () => {
  const saved = await author();
  await db.prisma.agentDefinition.update({
    where: { id: saved.input.agentId },
    data: { isEnabled: true },
  });
  const removedId = `${saved.proposal.id}:second`;
  await db.prisma.agentTrigger.update({
    where: { id: removedId },
    data: {
      isEnabled: true,
      activationState: 'ACTIVE',
      activationGeneration: 1,
      activationBoundary: { provider: 'GITHUB', headEventId: null, sourceOrder: 0 },
    },
  });
  const eventId = await fixture.event('removed-member-history');
  await fixture.admit(eventId, { agentDefinitionId: saved.input.agentId, triggerId: removedId });
  const updated = await saved.service.update({
    workspaceId: saved.authoring.id,
    proposalId: saved.proposal.id,
    revision: 1,
    specification: {
      ...saved.proposal.specification,
      triggers: saved.proposal.specification.triggers.slice(0, 1),
    },
  });
  await workspace.workspaceDataService.delete(saved.authoring.id);
  expect(await db.prisma.agentProposal.count({ where: { id: saved.proposal.id } })).toBe(0);
  const rows = await db.prisma.agentTrigger.findMany({
    where: { agentDefinitionId: saved.input.agentId },
    orderBy: { id: 'asc' },
  });
  expect(rows).toEqual([
    expect.objectContaining({ id: `${updated.id}:first`, isConfigured: true }),
    expect.objectContaining({ id: `${updated.id}:second`, isConfigured: false }),
  ]);
  expect(
    await db.prisma.agentEvaluation.findFirstOrThrow({
      where: { agentDefinitionId: saved.input.agentId },
    })
  ).toMatchObject({ triggerId: removedId, eventId });
  expect(
    await db.prisma.agentRun.findFirstOrThrow({ where: { agentDefinitionId: saved.input.agentId } })
  ).toMatchObject({ triggerId: removedId, status: 'CANCELLED' });
  const management = new runtime.AgentManagementService();
  const current = await management.get(saved.input);
  expect(current.configurationMembership).toBe('KNOWN');
  expect(current.specification?.triggers.map((trigger) => trigger.id)).toEqual([
    `${updated.id}:first`,
  ]);
  const result = await management.updateSaved(
    {
      ...saved.input,
      expectedManagementRevision: current.managementRevision,
      specification: {
        ...current.specification!,
        triggers: [
          ...current.specification!.triggers,
          {
            ...current.specification!.triggers[0]!,
            id: undefined,
            description: 'New saved member',
          },
        ],
      },
    },
    saved.evidence
  );
  expect(result.specification?.triggers).toHaveLength(2);
  const newId = result.specification!.triggers.find(
    (trigger) => trigger.description === 'New saved member'
  )!.id;
  expect(newId).toBeTruthy();
  expect(newId).not.toContain(saved.proposal.id);
  expect((await management.get(saved.input)).specification).toEqual(result.specification);
  expect(
    await db.prisma.agentTrigger.count({ where: { agentDefinitionId: saved.input.agentId } })
  ).toBe(3);
});

it.each(['saved', 'proposal'] as const)(
  'rejects a stale %s editor across the other entrypoint',
  async (loser) => {
    const saved = await author();
    const management = new runtime.AgentManagementService();
    const original = await management.get(saved.input);
    const proposalEdit = () =>
      saved.service.update({
        workspaceId: saved.authoring.id,
        proposalId: saved.proposal.id,
        revision: 1,
        specification: { ...saved.proposal.specification, instructions: 'Changed task' },
      });
    const savedEdit = () =>
      management.updateSaved(
        {
          ...saved.input,
          expectedManagementRevision: 1,
          specification: { ...original.specification!, name: 'Renamed' },
        },
        saved.evidence
      );
    await (loser === 'saved' ? proposalEdit() : savedEdit());
    await expect(loser === 'saved' ? savedEdit() : proposalEdit()).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    const current = await management.get(saved.input);
    expect(current.managementRevision).toBe(2);
    const card = await saved.service.get(saved.authoring.id, saved.proposal.id);
    expect(card.revision).toBe(2);
    expect(card.specification.name).toBe(current.specification?.name);
    expect(card.specification.instructions).toBe(current.specification?.instructions);
    expect(card.specification.triggers.map((trigger) => trigger.id)).toEqual(['first', 'second']);
  }
);

it.each([null, false])(
  'pauses re-established %s membership while preserving a known unchanged member',
  async (membership) => {
    const saved = await author();
    const management = new runtime.AgentManagementService();
    const original = await management.get(saved.input);
    await db.prisma.agentDefinition.update({
      where: { id: saved.input.agentId },
      data: { isEnabled: true },
    });
    await db.prisma.agentTrigger.updateMany({
      where: { agentDefinitionId: saved.input.agentId },
      data: {
        isEnabled: true,
        activationState: 'ACTIVE',
        activationGeneration: 1,
        activationBoundary: { provider: 'GITHUB', headEventId: null, sourceOrder: 0 },
      },
    });
    const id = `${saved.proposal.id}:first`;
    await db.prisma.agentTrigger.update({ where: { id }, data: { isConfigured: membership } });
    const admitted = await fixture.admit(await fixture.event('membership'), {
      agentDefinitionId: saved.input.agentId,
      triggerId: id,
    });
    expect(admitted.status).toBe('ADMITTED');
    const before = await management.get(saved.input);
    if (membership === null) {
      expect(before.configurationMembership).toBe('UNKNOWN');
      expect(before.specification).toBeNull();
    }
    await management.updateSaved(
      {
        ...saved.input,
        expectedManagementRevision: 1,
        specification: { ...original.specification!, name: 'Rename and establish set' },
      },
      saved.evidence
    );
    expect(await db.prisma.agentTrigger.findUniqueOrThrow({ where: { id } })).toMatchObject({
      isConfigured: true,
      isEnabled: false,
      activationState: 'PAUSED',
      triggerRevision: 2,
      activationGeneration: 2,
      activationBoundary: null,
      pendingActivation: null,
    });
    expect(
      await db.prisma.agentTrigger.findUniqueOrThrow({
        where: { id: `${saved.proposal.id}:second` },
      })
    ).toMatchObject({
      isConfigured: true,
      isEnabled: true,
      activationState: 'ACTIVE',
      triggerRevision: 1,
      activationGeneration: 1,
    });
    expect(
      await db.prisma.agentRun.findFirstOrThrow({
        where: { agentDefinitionId: saved.input.agentId },
      })
    ).toMatchObject({ status: 'CANCELLED' });
    expect(await db.prisma.agentInitialDelivery.findFirstOrThrow()).toMatchObject({
      state: 'FINISHED',
    });
  }
);

it('pages retained run identity and safe results independently of pruned events and history limits', async () => {
  const saved = await author();
  const management = new runtime.AgentManagementService();
  const createdAt = new Date('2026-01-01T00:00:00.000Z');
  for (let index = 0; index < 52; index += 1) {
    await db.prisma.agentRun.create({
      data: {
        id: `history-${String(index).padStart(3, '0')}`,
        agentDefinitionId: saved.input.agentId,
        triggerId: `${saved.proposal.id}:first`,
        idempotencyKey: `history-${index}`,
        status: index === 0 ? 'FAILED' : 'QUEUED',
        launchPhase: index === 0 ? 'FINISHED' : 'RESERVED',
        createdAt,
        completedAt: index === 0 ? createdAt : null,
        definitionSnapshot: { secret: 'SECRET_PROMPT' },
        input: { secret: 'SECRET_INPUT' },
        errorMessage: 'SECRET_ERROR',
        result: {
          version: 1,
          summary: 'Retained result',
          pullRequests: [{ url: 'https://github.com/org/repo/pull/1', number: 1 }],
        },
      },
    });
  }
  const page = await management.runs({ ...saved.input, limit: 50 });
  expect(page.items).toHaveLength(50);
  expect(page.items[0]).toMatchObject({
    id: 'history-051',
    startedAt: null,
    eventId: null,
    result: { summary: 'Retained result' },
  });
  expect(JSON.stringify(page)).not.toMatch(/SECRET_/);
  const tail = await management.runs({ ...saved.input, limit: 50, cursor: page.nextCursor! });
  expect(tail.items.map((row) => row.id)).toEqual(['history-001', 'history-000']);
  expect(tail.nextCursor).toBeNull();
  expect(await management.navigationSummary({ projectId: saved.input.projectId })).toEqual({
    totalCount: 2,
    failedCount: 1,
  });
  await expect(
    management.runs({ ...saved.input, projectId: 'foreign', cursor: page.nextCursor! })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(
    management.evaluations({ ...saved.input, cursor: page.nextCursor! })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});

it.each(['saved', 'proposal'] as const)(
  'serializes the actual overlapping %s winner against the other editor',
  async (winner) => {
    const saved = await author();
    const management = new runtime.AgentManagementService();
    const original = await management.get(saved.input);
    const write = {
      saved: () =>
        management.updateSaved(
          {
            ...saved.input,
            expectedManagementRevision: 1,
            specification: { ...original.specification!, name: 'Saved winner' },
          },
          saved.evidence
        ),
      proposal: () =>
        saved.service.update({
          workspaceId: saved.authoring.id,
          proposalId: saved.proposal.id,
          revision: 1,
          specification: { ...saved.proposal.specification, instructions: 'Proposal winner' },
        }),
    };
    const held = {
      winner,
      locked: false,
      acquired: deferred(),
      requested: deferred(),
      release: deferred(),
    };
    gate = held;
    try {
      const first = write[winner]();
      await Promise.race([
        held.acquired.promise,
        first.then(() => {
          throw new Error('Winner bypassed real lock');
        }),
      ]);
      let settled = false;
      const second = write[winner === 'saved' ? 'proposal' : 'saved']().then(
        () => {
          settled = true;
          return null;
        },
        (error: unknown) => {
          settled = true;
          return error;
        }
      );
      await Promise.race([
        held.requested.promise,
        second.then(() => {
          throw new Error('Contender bypassed real transaction queue');
        }),
      ]);
      expect(settled).toBe(false);
      held.release.resolve();
      await first;
      expect(await second).toMatchObject({ code: 'CONFLICT' });
      gate = undefined;
      expect((await management.get(saved.input)).managementRevision).toBe(2);
      expect((await saved.service.get(saved.authoring.id, saved.proposal.id)).revision).toBe(2);
    } finally {
      gate = undefined;
      held.release.resolve();
    }
  }
);

it('rejects borrowed/duplicate IDs and preserves claimed snapshots during a saved execution edit', async () => {
  const saved = await author();
  const management = new runtime.AgentManagementService();
  const original = await management.get(saved.input);
  const invalid = {
    ...original.specification!,
    triggers: [{ ...original.specification!.triggers[0]!, id: fixture.triggerId }],
  };
  await expect(
    management.updateSaved(
      { ...saved.input, expectedManagementRevision: 1, specification: invalid },
      saved.evidence
    )
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(
    management.updateSaved(
      {
        ...saved.input,
        expectedManagementRevision: 1,
        specification: {
          ...original.specification!,
          triggers: [original.specification!.triggers[0]!, original.specification!.triggers[0]!],
        },
      },
      saved.evidence
    )
  ).rejects.toThrow();
  await db.prisma.agentDefinition.update({
    where: { id: saved.input.agentId },
    data: { isEnabled: true },
  });
  const id = `${saved.proposal.id}:first`;
  await db.prisma.agentTrigger.update({
    where: { id },
    data: {
      isEnabled: true,
      activationState: 'ACTIVE',
      activationGeneration: 1,
      activationBoundary: { provider: 'GITHUB', headEventId: null, sourceOrder: 0 },
    },
  });
  await fixture.admit(await fixture.event('claimed-save'), {
    agentDefinitionId: saved.input.agentId,
    triggerId: id,
  });
  const claim = await runtime.claimNextRun();
  expect(claim.status).toBe('CLAIMED');
  const frozen = await db.prisma.agentRun.findFirstOrThrow({
    where: { agentDefinitionId: saved.input.agentId },
  });
  await fixture.admit(await fixture.event('queued-save'), {
    agentDefinitionId: saved.input.agentId,
    triggerId: id,
  });
  await management.updateSaved(
    {
      ...saved.input,
      expectedManagementRevision: 1,
      specification: { ...original.specification!, instructions: 'Changed saved execution' },
    },
    saved.evidence
  );
  const after = await db.prisma.agentRun.findUniqueOrThrow({ where: { id: frozen.id } });
  expect(after).toEqual(frozen);
  expect(
    await db.prisma.agentRun.count({
      where: { agentDefinitionId: saved.input.agentId, status: 'CANCELLED' },
    })
  ).toBe(1);
});

it('keeps historical actor restrictions inspectable and requires their explicit removal', async () => {
  const saved = await author();
  const management = new runtime.AgentManagementService();
  const original = await management.get(saved.input);
  const id = `${saved.proposal.id}:first`;
  await db.prisma.agentTrigger.update({
    where: { id },
    data: {
      config: {
        version: 1,
        repositoryIds: ['repo-1'],
        actions: ['labeled'],
        creatorIds: ['historic-user'],
      },
    },
  });
  const historic = await management.get(saved.input);
  expect(historic.specification).toBeNull();
  expect(historic.configuredTriggers[0]).toMatchObject({
    configuration: { config: { creatorIds: ['historic-user'] } },
    capability: { reasonCode: 'UNSUPPORTED_ACTOR_FILTER' },
  });
  await management.updateSaved(
    { ...saved.input, expectedManagementRevision: 1, specification: original.specification },
    saved.evidence
  );
  expect((await management.get(saved.input)).specification).not.toBeNull();
});

it('preserves safe run outcome and result through actual ledger retention', async () => {
  const eventId = await fixture.event('retained-history');
  await fixture.admit(eventId);
  const run = await db.prisma.agentRun.findFirstOrThrow({
    where: { agentDefinitionId: fixture.definitionId },
  });
  const project = await db.prisma.agentDefinition.findUniqueOrThrow({
    where: { id: fixture.definitionId },
  });
  await db.prisma.agentRun.update({
    where: { id: run.id },
    data: {
      status: 'FAILED',
      launchPhase: 'FINISHED',
      completedAt: new Date(),
      result: {
        version: 1,
        summary: 'Retained after pruning',
        pullRequests: [{ url: 'https://github.com/org/repo/pull/7', number: 7 }],
      },
    },
  });
  const delivery = await db.prisma.agentInitialDelivery.findUniqueOrThrow({
    where: { runId: run.id },
  });
  await db.prisma.agentInitialDelivery.update({
    where: { id: delivery.id },
    data: {
      state: 'FINISHED',
      evidence: {
        version: 1,
        attempt: {
          runId: run.id,
          sessionId: run.reservedSessionId!,
          messageId: delivery.messageId,
          sendAttemptId: delivery.sendAttemptId,
          workerGeneration: 1,
          attemptGeneration: 1,
        },
        outcome: {
          result: 'FAILED',
          stopReason: 'refusal',
          source: {
            version: 1,
            provider: 'CLAUDE',
            providerSessionId: 'private-provider-id',
            runtimeIncarnationId: 'private-runtime',
            lifecycleGeneration: 1,
          },
        },
      },
    },
  });
  const event = await db.prisma.agentEvent.findUniqueOrThrow({ where: { id: eventId } });
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(event.identityExpiresAt);
    await new runtime.AgentLedgerRetentionService().pruneExpired(new AbortController().signal);
    expect(await db.prisma.agentEvent.findUnique({ where: { id: eventId } })).toBeNull();
    const management = new runtime.AgentManagementService();
    expect(
      (await management.evaluations({ projectId: project.projectId, agentId: project.id })).items
    ).toEqual([]);
    const history = await management.runs({ projectId: project.projectId, agentId: project.id });
    expect(history.items[0]).toMatchObject({
      eventId: null,
      initialOutcome: { result: 'FAILED', stopReason: 'refusal' },
      result: { summary: 'Retained after pruning', pullRequests: [{ number: 7 }] },
    });
    expect(JSON.stringify(history)).not.toMatch(
      /private-provider|private-runtime|Frozen issue context/
    );
  } finally {
    vi.useRealTimers();
  }
});

it('bounds retained rows and detects unknown membership beyond the first page', async () => {
  const saved = await author();
  const management = new runtime.AgentManagementService();
  const first = await db.prisma.agentTrigger.findUniqueOrThrow({
    where: { id: `${saved.proposal.id}:first` },
  });
  for (let index = 0; index < 105; index += 1) {
    await db.prisma.agentTrigger.create({
      data: {
        agentDefinitionId: saved.input.agentId,
        type: first.type,
        connectionId: first.connectionId,
        description: 'Removed',
        config: first.config!,
        isConfigured: index === 0 ? null : false,
        createdAt: new Date(index),
      },
    });
  }
  const page = await management.get(saved.input);
  expect(page.configurationMembership).toBe('UNKNOWN');
  expect(page.specification).toBeNull();
  expect(page.configuredTriggers).toEqual([]);
  expect(page.retainedTriggers).toHaveLength(100);
  expect(page.retainedNextCursor).toBeTruthy();
  expect(
    (await management.get({ ...saved.input, retainedCursor: page.retainedNextCursor! }))
      .retainedTriggers
  ).toHaveLength(7);
});

it('round-trips the longest proposal-local ID and server-assigned new linked IDs without prefixes accumulating', async () => {
  const saved = await author();
  const longLocalId = 'x'.repeat(128);
  const proposal = await saved.service.update({
    workspaceId: saved.authoring.id,
    proposalId: saved.proposal.id,
    revision: 1,
    specification: {
      ...saved.proposal.specification,
      triggers: [{ ...saved.proposal.specification.triggers[0]!, id: longLocalId }],
    },
  });
  const management = new runtime.AgentManagementService();
  const original = await management.get(saved.input);
  expect(original.specification?.triggers[0]?.id).toBe(`${proposal.id}:${longLocalId}`);
  const updated = await management.updateSaved(
    {
      ...saved.input,
      expectedManagementRevision: 2,
      specification: {
        ...original.specification!,
        triggers: [
          ...original.specification!.triggers,
          {
            ...original.specification!.triggers[0]!,
            id: undefined,
            description: 'New linked member',
          },
        ],
      },
    },
    saved.evidence
  );
  const card = await saved.service.get(saved.authoring.id, proposal.id);
  expect(card.specification.triggers[0]?.id).toBe(longLocalId);
  const localId = card.specification.triggers[1]!.id!;
  expect(localId).not.toContain(proposal.id);
  expect(
    updated.specification?.triggers.find((trigger) => trigger.description === 'New linked member')
      ?.id
  ).toBe(`${proposal.id}:${localId}`);
  await saved.service.update({
    workspaceId: saved.authoring.id,
    proposalId: proposal.id,
    revision: card.revision,
    specification: card.specification,
  });
  expect((await management.get(saved.input)).specification).toEqual(updated.specification);
});
