import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import type { EventAgentExecution } from '@/shared/event-agent-launch';
import { Prisma } from '@prisma-gen/client';

let db: IntegrationDatabase;
let service: ReturnType<typeof import('./session-data.service').createSessionDataService>;
let accountAvailable = true;
let accountEnabled = true;
const execution: EventAgentExecution = {
  version: 1,
  provider: 'CLAUDE',
  model: 'sonnet',
  reasoningEffort: 'high',
  codexAccountId: null,
  startupModePreset: 'non_interactive',
  accessMode: 'bypassPermissions',
  planModeEnabled: false,
};
const codex: EventAgentExecution = {
  ...execution,
  provider: 'CODEX',
  model: 'gpt-5.4',
  codexAccountId: 'account',
  accessMode: 'workspace-write',
};
const input = () => ({ id: 'session', workspaceId: 'workspace', runId: 'run', execution });
beforeAll(async () => {
  db = await createIntegrationDatabase();
  const { createSessionDataService } =
    await vi.importActual<typeof import('./session-data.service')>('./session-data.service');
  service = createSessionDataService({
    providerResolver: {
      resolveSessionDefaults: () => {
        throw new Error('Event creation must not resolve defaults');
      },
    },
    accounts: {
      withAccountReservation: () => {
        throw new Error('Event creation must not re-enter account reservation');
      },
    },
    eventAccounts: {
      getEnabledAccountIds: () =>
        Promise.resolve(accountEnabled ? ['account', 'other-account'] : []),
      getRuntimeContext: (id) => {
        if (!(['account', 'other-account'].includes(id ?? '') && accountAvailable)) {
          return Promise.reject(new Error('Auth token=private-secret unavailable'));
        }
        return Promise.resolve({
          accountId: id ?? 'unexpected',
          homeDir: '/unused',
          sessionsDir: '/unused',
          env: {},
        });
      },
    },
  });
  expect(service.createEventSessionOnce).toBeTypeOf('function');
}, 30_000);
beforeEach(async () => {
  accountAvailable = true;
  accountEnabled = true;
  await db.prisma.agentDefinition.deleteMany();
  await db.prisma.workspace.deleteMany();
  await db.prisma.agentSessionLaunchOrigin.deleteMany();
  await db.prisma.workspaceLaunchOrigin.deleteMany();
  await db.prisma.project.deleteMany();
  await db.prisma.codexAccount.upsert({
    where: { id: 'account' },
    create: { id: 'account', label: 'Frozen', kind: 'NATIVE_DEFAULT' },
    update: {},
  });
  await db.prisma.project.create({
    data: {
      id: 'project',
      name: 'Repo',
      slug: 'repo',
      repoPath: '/repo',
      worktreeBasePath: '/worktrees',
      workspaces: {
        create: {
          id: 'workspace',
          name: 'Event',
          creationSource: 'EVENT_AGENT',
          creationMetadata: { runId: 'run', reservedSessionId: 'session' },
        },
      },
    },
  });
  await db.prisma.workspaceLaunchOrigin.create({
    data: { runId: 'run', workspaceId: 'workspace', projectId: 'project' },
  });
  await db.prisma.agentDefinition.create({
    data: { id: 'definition', projectId: 'project', name: 'Agent', instructions: 'Investigate' },
  });
  await db.prisma.agentRun.create({
    data: {
      id: 'run',
      agentDefinitionId: 'definition',
      idempotencyKey: 'event',
      reservedWorkspaceId: 'workspace',
      reservedSessionId: 'session',
      initialMessageId: 'message',
      effectiveExecution: execution,
      definitionSnapshot: {},
      input: { version: 1 },
    },
  });
});
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});
it.each([execution, codex])(
  'creates once with exact $provider settings under concurrent attempts',
  async (intent) => {
    await freeze(intent);
    const data = { ...input(), execution: intent };
    const results = await Promise.all([
      service.createEventSessionOnce(data),
      service.createEventSessionOnce(data),
    ]);
    expect(results.map((row) => row.id)).toEqual(['session', 'session']);
    expect(await db.prisma.agentSession.count()).toBe(1);
    expect(results[0]).toMatchObject({
      workflow: 'event-agent',
      model: intent.model,
      provider: intent.provider,
      codexAccountId: intent.codexAccountId,
      providerMetadata: {
        launchSettings: {
          reasoningEffort: 'high',
          planModeEnabled: false,
          accessMode: intent.accessMode,
          applied: false,
        },
      },
    });
    expect(await service.findEventSessionOrigin('session')).toMatchObject({
      runId: 'run',
      workspaceId: 'workspace',
      execution: intent,
    });
  }
);
it('compares original intent after mutable model and launch settings have changed', async () => {
  await service.createEventSessionOnce(input());
  await db.prisma.agentSession.update({
    where: { id: 'session' },
    data: {
      model: 'opus',
      providerMetadata: { launchSettings: { reasoningEffort: 'low', applied: true } },
    },
  });
  expect(await service.createEventSessionOnce(input())).toMatchObject({
    id: 'session',
    model: 'opus',
  });
  await expect(
    service.createEventSessionOnce({ ...input(), execution: { ...execution, model: 'opus' } })
  ).rejects.toThrow(/intent/i);
});
it('refuses deleted-session resurrection before linkage and retains provenance through workspace deletion', async () => {
  await service.createEventSessionOnce(input());
  await db.prisma.agentSession.delete({ where: { id: 'session' } });
  await expect(service.createEventSessionOnce(input())).rejects.toThrow(/deleted/i);
  await db.prisma.workspace.delete({ where: { id: 'workspace' } });
  expect(await service.findEventSessionOrigin('session')).toMatchObject({
    runId: 'run',
    workspaceId: 'workspace',
  });
  expect(await db.prisma.agentSession.count()).toBe(0);
});
it.each([{ id: 'other' }, { runId: 'other' }, { workspaceId: 'other' }])(
  'rejects origin identity mismatch %j',
  async (patch) => {
    await service.createEventSessionOnce(input());
    await expect(service.createEventSessionOnce({ ...input(), ...patch })).rejects.toThrow(
      /ownership/i
    );
  }
);
it.each(['ARCHIVING', 'ARCHIVED'] as const)(
  'refuses session creation in a %s workspace',
  async (status) => {
    await db.prisma.workspace.update({ where: { id: 'workspace' }, data: { status } });
    await expect(service.createEventSessionOnce(input())).rejects.toThrow(/archiv/i);
    expect(await db.prisma.agentSessionLaunchOrigin.count()).toBe(0);
  }
);
it('fails for an unavailable frozen account without selecting Auto or entering reservation', async () => {
  await freeze(codex);
  const data = { ...input(), execution: codex };
  await service.createEventSessionOnce(data);
  accountAvailable = false;
  await expect(service.createEventSessionOnce(data)).rejects.toMatchObject({
    name: 'ApplicationError',
    code: 'PRECONDITION_FAILED',
    message: 'Frozen Codex account is unavailable',
  });
  expect(await db.prisma.agentSession.findUnique({ where: { id: 'session' } })).toMatchObject({
    codexAccountId: 'account',
  });
});
it('rejects malformed intent and never stores credential-bearing extra fields', async () => {
  await expect(
    service.createEventSessionOnce({
      ...input(),
      execution: { ...execution, token: 'forbidden' },
    } as never)
  ).rejects.toThrow();
  await expect(
    service.createEventSessionOnce({
      ...input(),
      execution: { ...codex, codexAccountId: null },
    } as never)
  ).rejects.toThrow();
  expect(await db.prisma.agentSession.count()).toBe(0);
});
it('rejects an ordinary session reserved ID before writing an origin', async () => {
  await db.prisma.agentSession.create({
    data: { id: 'session', workspaceId: 'workspace', provider: 'CLAUDE', workflow: 'followup' },
  });
  await expect(service.createEventSessionOnce(input())).rejects.toMatchObject({
    code: 'CONFLICT',
    message: 'Event session ownership mismatch',
  });
  expect(await db.prisma.agentSessionLaunchOrigin.count()).toBe(0);
});

it('rejects a disabled frozen account before inserting its session', async () => {
  accountEnabled = false;
  await expect(service.createEventSessionOnce({ ...input(), execution: codex })).rejects.toThrow(
    /unavailable/i
  );
  expect(await db.prisma.agentSession.count()).toBe(0);
});

it.each([{ id: 'foreign-session' }, { runId: 'foreign-run' }])(
  'rejects a first create borrowing another reserved workspace identity %j',
  async (patch) => {
    await expect(service.createEventSessionOnce({ ...input(), ...patch })).rejects.toThrow(
      /ownership/i
    );
    expect(await db.prisma.agentSessionLaunchOrigin.count()).toBe(0);
  }
);
it('refuses a first create in an ordinary workspace and an archived project', async () => {
  await db.prisma.workspace.update({
    where: { id: 'workspace' },
    data: { creationSource: 'MANUAL' },
  });
  await expect(service.createEventSessionOnce(input())).rejects.toThrow(/ownership/i);
  await db.prisma.workspace.update({
    where: { id: 'workspace' },
    data: { creationSource: 'EVENT_AGENT' },
  });
  await db.prisma.project.update({ where: { id: 'project' }, data: { isArchived: true } });
  await expect(service.createEventSessionOnce(input())).rejects.toThrow(/archiv/i);
  expect(await db.prisma.agentSessionLaunchOrigin.count()).toBe(0);
});
it('rejects the session insert when the frozen account row is missing despite successful validation', async () => {
  await freeze(codex);
  await db.prisma.codexAccount.delete({ where: { id: 'account' } });
  await expect(
    service.createEventSessionOnce({ ...input(), execution: codex })
  ).rejects.toMatchObject({ code: 'P2003', meta: { modelName: 'AgentSession' } });
  expect(await db.prisma.agentSessionLaunchOrigin.count()).toBe(0);
  expect(await db.prisma.agentSession.count()).toBe(0);
});

async function freeze(intent: EventAgentExecution) {
  await db.prisma.agentRun.update({ where: { id: 'run' }, data: { effectiveExecution: intent } });
}
it.each([
  'missing-run',
  'missing-binding',
  'corrupt-binding',
  'workspace',
  'session',
  'project',
] as const)('rejects first creation with invalid frozen run integrity: %s', async (change) => {
  if (change === 'missing-run') {
    await db.prisma.agentRun.delete({ where: { id: 'run' } });
  }
  if (change === 'missing-binding') {
    await db.prisma.agentRun.update({
      where: { id: 'run' },
      data: { effectiveExecution: Prisma.DbNull },
    });
  }
  if (change === 'corrupt-binding') {
    await db.prisma.agentRun.update({
      where: { id: 'run' },
      data: { effectiveExecution: { version: 999 } },
    });
  }
  if (change === 'workspace') {
    await db.prisma.agentRun.update({
      where: { id: 'run' },
      data: { reservedWorkspaceId: 'foreign' },
    });
  }
  if (change === 'session') {
    await db.prisma.agentRun.update({
      where: { id: 'run' },
      data: { reservedSessionId: 'foreign' },
    });
  }
  if (change === 'project') {
    await db.prisma.project.create({
      data: {
        id: 'foreign',
        name: 'Other',
        slug: 'other',
        repoPath: '/other',
        worktreeBasePath: '/other-trees',
      },
    });
    await db.prisma.agentDefinition.update({
      where: { id: 'definition' },
      data: { projectId: 'foreign' },
    });
  }
  await expect(service.createEventSessionOnce(input())).rejects.toMatchObject({
    code: 'CONFLICT',
    message: 'Event session does not match the frozen run binding',
  });
  expect(await db.prisma.agentSession.count()).toBe(0);
  expect(await db.prisma.agentSessionLaunchOrigin.count()).toBe(0);
});
it.each([{ model: 'opus' }, { reasoningEffort: 'low' }, { accessMode: 'default' }])(
  'rejects first creation diverging from frozen execution %j',
  async (patch) => {
    await expect(
      service.createEventSessionOnce({ ...input(), execution: { ...execution, ...patch } })
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Event session does not match the frozen run binding',
    });
    expect(await db.prisma.agentSession.count()).toBe(0);
  }
);
it('rejects a different valid Codex account on first insertion', async () => {
  await freeze(codex);
  await db.prisma.codexAccount.create({
    data: { id: 'other-account', label: 'Other', kind: 'MANAGED' },
  });
  await expect(
    service.createEventSessionOnce({
      ...input(),
      execution: { ...codex, codexAccountId: 'other-account' },
    })
  ).rejects.toMatchObject({
    code: 'CONFLICT',
    message: 'Event session does not match the frozen run binding',
  });
  expect(await db.prisma.agentSession.count()).toBe(0);
});
it('reuses immutable session origin after the run is removed', async () => {
  await service.createEventSessionOnce(input());
  await db.prisma.agentRun.delete({ where: { id: 'run' } });
  expect(await service.createEventSessionOnce(input())).toMatchObject({ id: 'session' });
});
it('sanitizes authentication errors without exposing their cause', async () => {
  accountAvailable = false;
  const error = await service
    .createEventSessionOnce({ ...input(), execution: codex })
    .catch((cause: unknown) => cause);
  expect(error).toMatchObject({
    name: 'ApplicationError',
    code: 'PRECONDITION_FAILED',
    message: 'Frozen Codex account is unavailable',
  });
  expect(error).not.toHaveProperty('cause');
  expect(String(error)).not.toContain('private-secret');
});
it('rolls back the session and inserted origin after an AFTER INSERT origin failure', async () => {
  await db.prisma.$executeRawUnsafe(
    `CREATE TRIGGER reject_session_origin AFTER INSERT ON AgentSessionLaunchOrigin BEGIN SELECT RAISE(ABORT, 'injected session origin failure'); END`
  );
  try {
    await expect(service.createEventSessionOnce(input())).rejects.toMatchObject({
      code: 'P2003',
      meta: { modelName: 'AgentSessionLaunchOrigin' },
    });
    expect(await db.prisma.agentSession.count()).toBe(0);
    expect(await db.prisma.agentSessionLaunchOrigin.count()).toBe(0);
  } finally {
    await db.prisma.$executeRawUnsafe('DROP TRIGGER reject_session_origin');
  }
});
