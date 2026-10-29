import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentSessionAccessor } from '@/backend/services/session/resources/agent-session.accessor';
import { prDedicatedSessionAccessor } from '@/backend/services/session/resources/pr-dedicated-session.accessor';
import { createLifecycleTestSession } from '@/backend/services/session/service/lifecycle/session-lifecycle.test-helpers';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import type { Workspace } from '@prisma-gen/client';
import { createSessionDataService } from './session-data.service';
afterEach(() => vi.restoreAllMocks());
describe('new Codex conversation account binding', () => {
  it.each(['ordinary', 'limited'] as const)(
    'binds Auto and explicit choices before %s persistence',
    async (kind) => {
      const create = vi
        .spyOn(agentSessionAccessor, 'create')
        .mockResolvedValue(createLifecycleTestSession());
      const limited = vi
        .spyOn(agentSessionAccessor, 'createWithinWorkspaceLimit')
        .mockResolvedValue({ outcome: 'created', session: createLifecycleTestSession() });
      const withAccountReservation = vi.fn(async ({ accountId }, callback) =>
        callback(accountId ?? 'auto-chosen')
      );
      const service = createSessionDataService({
        providerResolver: {
          resolveSessionDefaults: vi.fn().mockResolvedValue({ provider: 'CODEX', model: 'gpt' }),
        },
        accounts: { withAccountReservation },
      });
      for (const accountId of [undefined, 'manual']) {
        const input = { workspaceId: 'workspace', workflow: 'followup', codexAccountId: accountId };
        if (kind === 'ordinary') {
          await service.createAgentSession(input);
        } else {
          await service.createAgentSessionWithinWorkspaceLimit({ ...input, maxSessions: 3 });
        }
        expect(kind === 'ordinary' ? create : limited).toHaveBeenLastCalledWith(
          expect.objectContaining({ codexAccountId: accountId ?? 'auto-chosen' })
        );
      }
      expect(withAccountReservation).toHaveBeenCalledTimes(2);
    }
  );
  it('preserves an existing dedicated conversation without resolving Auto again', async () => {
    const session = createLifecycleTestSession({ provider: 'CODEX', codexAccountId: 'original' });
    vi.spyOn(prDedicatedSessionAccessor, 'findWorkspace').mockResolvedValue(
      unsafeCoerce<Workspace>({ id: 'w' })
    );
    vi.spyOn(prDedicatedSessionAccessor, 'find').mockResolvedValue(session);
    const acquire = vi
      .spyOn(prDedicatedSessionAccessor, 'acquire')
      .mockResolvedValue({ outcome: 'reused', session });
    const withAccountReservation = vi.fn();
    const service = createSessionDataService({
      providerResolver: {
        resolveSessionDefaults: vi.fn().mockResolvedValue({ provider: 'CODEX', model: 'default' }),
      },
      accounts: { withAccountReservation },
    });
    expect(
      await service.acquirePRDedicatedSession({ workspaceId: 'w', prId: 'pr', maxSessions: 2 })
    ).toMatchObject({ session: { codexAccountId: 'original' } });
    expect(withAccountReservation).not.toHaveBeenCalled();
    expect(acquire).toHaveBeenCalledWith(expect.objectContaining({ codexAccountId: 'original' }));
  });
  it('rejects an explicit Codex account for Claude', async () => {
    const create = vi
      .spyOn(agentSessionAccessor, 'create')
      .mockResolvedValue(createLifecycleTestSession());
    const withAccountReservation = vi.fn();
    const service = createSessionDataService({
      providerResolver: {
        resolveSessionDefaults: vi.fn().mockResolvedValue({ provider: 'CLAUDE', model: 'sonnet' }),
      },
      accounts: { withAccountReservation },
    });
    await expect(
      service.createAgentSession({
        workspaceId: 'workspace',
        workflow: 'followup',
        codexAccountId: 'stale-choice',
      })
    ).rejects.toThrow('Codex account');
    expect(withAccountReservation).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});
