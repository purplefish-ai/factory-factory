import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import type { EventAgentExecution } from '@/shared/event-agent-launch';

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
      getEnabledAccountIds: () => Promise.resolve(accountEnabled ? ['account'] : []),
      getRuntimeContext: (id) => {
        if (id !== 'account' || !accountAvailable) {
          return Promise.reject(new Error('Frozen account unavailable'));
        }
        return Promise.resolve({
          accountId: id,
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
});
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});
it.each([execution, codex])(
  'creates once with exact $provider settings under concurrent attempts',
  async (intent) => {
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
  const data = { ...input(), execution: codex };
  await service.createEventSessionOnce(data);
  accountAvailable = false;
  await expect(service.createEventSessionOnce(data)).rejects.toThrow(/unavailable/i);
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
it('rolls back origin if a reserved ID already belongs to an ordinary session', async () => {
  await db.prisma.agentSession.create({
    data: { id: 'session', workspaceId: 'workspace', provider: 'CLAUDE', workflow: 'followup' },
  });
  await expect(service.createEventSessionOnce(input())).rejects.toThrow();
  expect(await db.prisma.agentSessionLaunchOrigin.count()).toBe(0);
});

it('rejects a disabled frozen account before inserting its session', async () => {
  accountEnabled = false;
  await expect(service.createEventSessionOnce({ ...input(), execution: codex })).rejects.toThrow(
    /disabled/i
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
it('fails atomically when the frozen account disappears between validation and insertion', async () => {
  await db.prisma.codexAccount.delete({ where: { id: 'account' } });
  await expect(service.createEventSessionOnce({ ...input(), execution: codex })).rejects.toThrow();
  expect(await db.prisma.agentSessionLaunchOrigin.count()).toBe(0);
  expect(await db.prisma.agentSession.count()).toBe(0);
});
