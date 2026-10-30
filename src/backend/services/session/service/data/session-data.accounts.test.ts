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
      const events: string[] = [];
      const persisted = () => {
        events.push('persist');
        return Promise.resolve(createLifecycleTestSession());
      };
      const create = vi.spyOn(agentSessionAccessor, 'create').mockImplementation(persisted);
      const limited = vi
        .spyOn(agentSessionAccessor, 'createWithinWorkspaceLimit')
        .mockImplementation(async () => ({
          outcome: 'created' as const,
          session: await persisted(),
        }));
      const withAccountReservation = vi.fn(async ({ accountId }, callback) => {
        events.push('reserved');
        try {
          return await callback(accountId ?? 'auto-chosen');
        } finally {
          events.push('released');
        }
      });
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
      expect(withAccountReservation.mock.calls.map(([input]) => input)).toEqual([
        { accountId: undefined, model: 'gpt' },
        { accountId: 'manual', model: 'gpt' },
      ]);
      expect(events).toEqual([
        'reserved',
        'persist',
        'released',
        'reserved',
        'persist',
        'released',
      ]);
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
    expect(acquire).toHaveBeenCalledWith(expect.objectContaining({ reuseOnly: true }));
  });
  it('reserves a fresh account if the dedicated session disappears before atomic reuse', async () => {
    const session = createLifecycleTestSession({ provider: 'CODEX', codexAccountId: 'fresh' });
    vi.spyOn(prDedicatedSessionAccessor, 'findWorkspace').mockResolvedValue(
      unsafeCoerce<Workspace>({ id: 'w' })
    );
    const staleLookup = vi
      .spyOn(prDedicatedSessionAccessor, 'find')
      .mockResolvedValue(createLifecycleTestSession({ codexAccountId: 'deleted' }));
    const events: string[] = [];
    const acquire = vi
      .spyOn(prDedicatedSessionAccessor, 'acquire')
      .mockResolvedValueOnce({ outcome: 'missing' })
      .mockImplementationOnce(() => {
        events.push('persist');
        return Promise.resolve({ outcome: 'created', session });
      });
    const withAccountReservation = vi.fn(async (_input, callback) => {
      events.push('reserved');
      try {
        return await callback('fresh');
      } finally {
        events.push('released');
      }
    });
    const service = createSessionDataService({
      providerResolver: {
        resolveSessionDefaults: vi.fn().mockResolvedValue({ provider: 'CODEX', model: 'gpt' }),
      },
      accounts: { withAccountReservation },
    });
    await expect(
      service.acquirePRDedicatedSession({ workspaceId: 'w', prId: 'pr', maxSessions: 2 })
    ).resolves.toMatchObject({ outcome: 'created', session: { codexAccountId: 'fresh' } });
    expect(staleLookup).not.toHaveBeenCalled();
    expect(withAccountReservation).toHaveBeenCalledWith(
      { accountId: undefined, model: 'gpt' },
      expect.any(Function)
    );
    expect(acquire).toHaveBeenLastCalledWith(expect.objectContaining({ codexAccountId: 'fresh' }));
    expect(events).toEqual(['reserved', 'persist', 'released']);
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
