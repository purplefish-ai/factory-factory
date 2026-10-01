import type { Workspace } from '@prisma-gen/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSessionRecord } from '@/backend/services/session';
import { sessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { SessionRepository } from './session.repository';

const createSession = (overrides?: Partial<AgentSessionRecord>): AgentSessionRecord =>
  ({
    id: 's1',
    workspaceId: 'w1',
    name: null,
    workflow: 'default',
    model: 'sonnet',
    status: 'IDLE',
    provider: 'CLAUDE',
    providerMetadata: null,
    providerSessionId: null,
    providerProjectPath: null,
    providerProcessPid: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  }) as AgentSessionRecord;

describe('SessionRepository', () => {
  const sessions = {
    findById: vi.fn<() => Promise<AgentSessionRecord | null>>(),
    findByWorkspaceId: vi.fn<() => Promise<AgentSessionRecord[]>>(),
    update: vi.fn<() => Promise<AgentSessionRecord>>(),
    updateIfProviderIdentity: vi.fn<() => Promise<number>>(),
    updateIfStatus: vi.fn<() => Promise<number>>(),
    delete: vi.fn<() => Promise<AgentSessionRecord>>(),
    recoverStaleRunning: vi.fn<() => Promise<number>>(),
  };

  const workspaces = {
    findById: vi.fn<() => Promise<Workspace | null>>(),
    recordSessionPresence: vi.fn<() => Promise<void>>(),
  };

  const repository = new SessionRepository(
    unsafeCoerce<ConstructorParameters<typeof SessionRepository>[0]>(sessions),
    workspaces
  );

  beforeEach(() => {
    vi.clearAllMocks();
    sessionDomainService.clearAllSessions();
  });

  it('allows first non-null providerSessionId assignment', async () => {
    sessions.findById.mockResolvedValue(createSession({ providerSessionId: null }));
    sessions.update.mockResolvedValue(createSession({ providerSessionId: 'provider-1' }));

    const updated = await repository.updateSession('s1', { providerSessionId: 'provider-1' });

    expect(updated.providerSessionId).toBe('provider-1');
    expect(sessions.update).toHaveBeenCalledWith('s1', { providerSessionId: 'provider-1' });
  });

  it('rejects combined initial identity and config writes rather than dropping identity', async () => {
    sessions.findById.mockResolvedValue(createSession());
    sessions.updateIfProviderIdentity.mockResolvedValue(1);
    await expect(
      repository.updateSession('s1', {
        providerSessionId: 'first',
        providerMetadata: { acpConfigSnapshot: { providerSessionId: 'first' } },
      })
    ).rejects.toThrow('Initial provider identity must be persisted before its config snapshot');
    expect(sessions.updateIfProviderIdentity).not.toHaveBeenCalled();
  });

  it('allows idempotent re-write of same providerSessionId', async () => {
    sessions.findById.mockResolvedValue(createSession({ providerSessionId: 'provider-1' }));
    sessions.update.mockResolvedValue(createSession({ providerSessionId: 'provider-1' }));

    await repository.updateSession('s1', { providerSessionId: 'provider-1' });

    expect(sessions.update).toHaveBeenCalledWith('s1', { providerSessionId: 'provider-1' });
  });

  it('rejects changing an existing providerSessionId', async () => {
    sessions.findById.mockResolvedValue(createSession({ providerSessionId: 'provider-1' }));

    await expect(
      repository.updateSession('s1', { providerSessionId: 'provider-2' })
    ).rejects.toThrow(/immutable/);
    expect(sessions.update).not.toHaveBeenCalled();
  });

  it('rejects clearing an existing providerSessionId', async () => {
    sessions.findById.mockResolvedValue(createSession({ providerSessionId: 'provider-1' }));

    await expect(repository.updateSession('s1', { providerSessionId: null })).rejects.toThrow(
      /immutable/
    );
    expect(sessions.update).not.toHaveBeenCalled();
  });

  it('rejects an old config snapshot after provider identity reconciliation', async () => {
    sessions.findById.mockResolvedValue(
      createSession({
        providerSessionId: 'new',
        providerMetadata: {
          acpConfigSnapshot: { providerSessionId: 'new' },
          providerIdentityRollovers: ['audit'],
        },
      })
    );
    sessions.update.mockResolvedValue(createSession());
    await expect(
      repository.updateSession('s1', {
        providerMetadata: {
          acpConfigSnapshot: { providerSessionId: 'old' },
        },
      })
    ).rejects.toThrow('Stale provider config snapshot');
    expect(sessions.update).not.toHaveBeenCalled();
  });

  it('rejects a config snapshot until an authoritative provider identity exists', async () => {
    sessions.findById.mockResolvedValue(createSession());
    sessions.updateIfProviderIdentity.mockResolvedValue(1);
    await expect(
      repository.updateSession('s1', {
        providerMetadata: { acpConfigSnapshot: { providerSessionId: 'stale' } },
      })
    ).rejects.toThrow('Stale provider config snapshot');
    expect(sessions.updateIfProviderIdentity).not.toHaveBeenCalled();
  });

  it('preserves durable rollover audit when a current config snapshot is refreshed', async () => {
    const current = createSession({
      providerSessionId: 'new',
      providerMetadata: {
        providerIdentityRollovers: ['audit'],
        keep: 'current',
      },
    });
    sessions.findById.mockResolvedValue(current);
    sessions.updateIfProviderIdentity.mockResolvedValue(1);
    await repository.updateSession('s1', {
      providerMetadata: { acpConfigSnapshot: { providerSessionId: 'new' } },
    });
    expect(sessions.updateIfProviderIdentity).toHaveBeenCalledWith('s1', current, {
      providerMetadata: {
        keep: 'current',
        providerIdentityRollovers: ['audit'],
        acpConfigSnapshot: { providerSessionId: 'new' },
      },
    });
    expect(sessions.update).not.toHaveBeenCalled();
  });

  it('rejects a config snapshot if identity changes between read and write', async () => {
    sessions.findById.mockResolvedValue(createSession({ providerSessionId: 'old' }));
    sessions.updateIfProviderIdentity.mockResolvedValue(0);
    await expect(
      repository.updateSession('s1', {
        providerMetadata: { acpConfigSnapshot: { providerSessionId: 'old' } },
      })
    ).rejects.toThrow('Stale provider metadata');
    expect(sessions.update).not.toHaveBeenCalled();
  });

  it('delegates stale running session recovery to the session accessor', async () => {
    sessions.recoverStaleRunning.mockResolvedValue(3);

    await expect(repository.recoverStaleRunningSessions()).resolves.toBe(3);

    expect(sessions.recoverStaleRunning).toHaveBeenCalledOnce();
  });

  it('releases the retained history fence only after durable deletion succeeds', async () => {
    sessionDomainService.resetProviderHistory('s1', 'new');
    sessionDomainService.clearSession('s1');
    sessions.delete.mockRejectedValueOnce(new Error('delete failed'));
    await expect(repository.deleteSession('s1')).rejects.toThrow('delete failed');
    expect(sessionDomainService.acceptProviderHistoryIdentity('s1', 'old')).toBe(false);
    sessions.delete.mockResolvedValue(createSession());
    await repository.deleteSession('s1');
    expect(sessionDomainService.acceptProviderHistoryIdentity('s1', 'old')).toBe(true);
  });

  it('delegates conditional session updates to the session accessor', async () => {
    sessions.updateIfStatus.mockResolvedValue(1);

    await expect(
      repository.updateSessionIfStatus('s1', { status: 'IDLE' }, ['RUNNING'])
    ).resolves.toBe(1);

    expect(sessions.updateIfStatus).toHaveBeenCalledWith('s1', { status: 'IDLE' }, ['RUNNING']);
  });
});
