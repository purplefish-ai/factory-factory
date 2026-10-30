import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { codexAccountService } from '@/backend/services/codex-accounts';
import { agentSessionAccessor } from '@/backend/services/session/resources/agent-session.accessor';
import { prDedicatedSessionAccessor } from '@/backend/services/session/resources/pr-dedicated-session.accessor';
import { createLifecycleTestSession } from '@/backend/services/session/service/lifecycle/session-lifecycle.test-helpers';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import type { Workspace } from '@prisma-gen/client';
import { createSessionDataService } from './session-data.service';

const workspace = unsafeCoerce<Workspace>({
  id: 'workspace',
  defaultSessionProvider: 'WORKSPACE_DEFAULT',
});
const input = { workspaceId: workspace.id, workflow: 'followup' };
const dedicated = { workspaceId: workspace.id, prId: 'pr', maxSessions: 3 };
function dataService() {
  const resolveSessionDefaults = vi
    .fn()
    .mockResolvedValue({ provider: 'CODEX', model: 'gpt-configured' });
  return {
    service: createSessionDataService({ providerResolver: { resolveSessionDefaults } }),
    resolveSessionDefaults,
  };
}
beforeEach(() => {
  vi.spyOn(agentSessionAccessor, 'create').mockResolvedValue(createLifecycleTestSession());
  vi.spyOn(agentSessionAccessor, 'createWithinWorkspaceLimit').mockResolvedValue({
    outcome: 'created',
    session: createLifecycleTestSession(),
  });
  vi.spyOn(prDedicatedSessionAccessor, 'find').mockResolvedValue(null);
  vi.spyOn(prDedicatedSessionAccessor, 'findWorkspace').mockResolvedValue(workspace);
  vi.spyOn(prDedicatedSessionAccessor, 'acquire').mockResolvedValue({
    outcome: 'created',
    session: createLifecycleTestSession(),
  });
});
afterEach(() => vi.restoreAllMocks());

describe('constructed session data service', () => {
  it.each(['ordinary', 'limited'] as const)(
    'passes resolved choices and exact launch metadata to %s persistence',
    async (kind) => {
      const { service } = dataService();
      const supplied = {
        ...input,
        provider: 'CLAUDE' as const,
        model: 'raw',
        reasoningEffort: null,
        planModeEnabled: false,
      };
      if (kind === 'ordinary') {
        await service.createAgentSession(supplied);
      } else {
        await service.createAgentSessionWithinWorkspaceLimit({ ...supplied, maxSessions: 3 });
      }
      const write =
        kind === 'ordinary'
          ? agentSessionAccessor.create
          : agentSessionAccessor.createWithinWorkspaceLimit;
      expect(write).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'CODEX',
          model: 'gpt-configured',
          providerMetadata: {
            launchSettings: { reasoningEffort: null, planModeEnabled: false, applied: false },
          },
        })
      );
    }
  );

  it.each([{}, { reasoningEffort: 'high', planModeEnabled: true }])(
    'keeps omitted or explicitly selected launch intent: %j',
    async (settings) => {
      const { service } = dataService();
      await service.createAgentSession({ ...input, ...settings });
      const written = vi.mocked(agentSessionAccessor.create).mock.calls[0]?.[0];
      if ('reasoningEffort' in settings) {
        expect(written?.providerMetadata).toEqual({
          launchSettings: { reasoningEffort: 'high', planModeEnabled: true, applied: false },
        });
      } else {
        expect(written).not.toHaveProperty('providerMetadata');
      }
    }
  );

  it.each(['ordinary', 'limited', 'dedicated'] as const)(
    'makes no %s write when injected resolution fails',
    async (kind) => {
      const { service, resolveSessionDefaults } = dataService();
      resolveSessionDefaults.mockRejectedValue(new Error('defaults unavailable'));
      const pending =
        kind === 'ordinary'
          ? service.createAgentSession(input)
          : kind === 'limited'
            ? service.createAgentSessionWithinWorkspaceLimit({ ...input, maxSessions: 3 })
            : service.acquirePRDedicatedSession(dedicated);
      await expect(pending).rejects.toThrow('defaults unavailable');
      expect(agentSessionAccessor.create).not.toHaveBeenCalled();
      expect(agentSessionAccessor.createWithinWorkspaceLimit).not.toHaveBeenCalled();
      expect(prDedicatedSessionAccessor.acquire).not.toHaveBeenCalled();
    }
  );

  it('retains the resource-owned limited outcome', async () => {
    const { service } = dataService();
    const limited = { outcome: 'limit_reached' as const };
    vi.mocked(agentSessionAccessor.createWithinWorkspaceLimit).mockResolvedValue(limited);
    expect(await service.createAgentSessionWithinWorkspaceLimit({ ...input, maxSessions: 0 })).toBe(
      limited
    );
  });

  it('returns unavailable before lookup or resolution for already cancelled dedicated creation', async () => {
    const { service, resolveSessionDefaults } = dataService();
    expect(
      await service.acquirePRDedicatedSession({ ...dedicated, isCurrent: () => false })
    ).toEqual({ outcome: 'unavailable' });
    expect(prDedicatedSessionAccessor.findWorkspace).not.toHaveBeenCalled();
    expect(resolveSessionDefaults).not.toHaveBeenCalled();
  });

  it('fences dedicated acquisition when cancellation occurs during asynchronous defaults', async () => {
    let finish!: (defaults: { provider: 'CODEX'; model: string }) => void;
    let entered!: () => void;
    const resolving = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const defaults = new Promise<{ provider: 'CODEX'; model: string }>((resolve) => {
      finish = resolve;
    });
    const service = createSessionDataService({
      providerResolver: {
        resolveSessionDefaults: () => {
          entered();
          return defaults;
        },
      },
    });
    let current = true;
    const pending = service.acquirePRDedicatedSession({ ...dedicated, isCurrent: () => current });
    await resolving;
    current = false;
    finish({ provider: 'CODEX', model: 'gpt-configured' });
    expect(await pending).toEqual({ outcome: 'unavailable' });
    expect(prDedicatedSessionAccessor.acquire).not.toHaveBeenCalled();
  });

  it('preserves reused session identity and stored choices despite newly resolved defaults', async () => {
    const { service } = dataService();
    vi.mocked(codexAccountService.withAccountReservation).mockClear();
    vi.mocked(prDedicatedSessionAccessor.acquire).mockResolvedValue({
      outcome: 'reused',
      session: createLifecycleTestSession({ id: 'existing', provider: 'CLAUDE', model: 'opus' }),
    });
    expect(await service.acquirePRDedicatedSession(dedicated)).toMatchObject({
      outcome: 'reused',
      session: { id: 'existing', provider: 'CLAUDE', model: 'opus' },
    });
    expect(codexAccountService.withAccountReservation).not.toHaveBeenCalled();
    expect(prDedicatedSessionAccessor.acquire).toHaveBeenCalledExactlyOnceWith({
      ...dedicated,
      provider: 'CODEX',
      model: 'gpt-configured',
      reuseOnly: true,
    });
  });
});

vi.mock('@/backend/services/codex-accounts', () => ({
  NATIVE_DEFAULT_CODEX_ACCOUNT_ID: 'codex-native-default',
  codexAccountService: {
    getRuntimeContext: vi.fn(async (accountId = 'codex-native-default') => ({
      accountId,
      homeDir: '/test/codex',
      sessionsDir: '/test/codex/sessions',
      env: { CODEX_HOME: '/test/codex' },
    })),
    getPreviewRuntimeContext: vi.fn(async ({ accountId = 'codex-native-default' } = {}) => ({
      accountId,
      homeDir: '/test/codex',
      sessionsDir: '/test/codex/sessions',
      env: { CODEX_HOME: '/test/codex' },
    })),
    withAccountReservation: vi.fn(async (input, create) =>
      create(input.accountId ?? 'codex-native-default')
    ),
    getUsage: vi.fn(),
  },
}));
