import type { Project, Workspace } from '@prisma-gen/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSessionRecord } from '@/backend/services/session';
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
    updateIfStatus: vi.fn<() => Promise<number>>(),
    delete: vi.fn<() => Promise<AgentSessionRecord>>(),
  };

  const workspaces = {
    findById: vi.fn<() => Promise<Workspace | null>>(),
    markHasHadSessions: vi.fn<() => Promise<void>>(),
  };

  const projects = {
    findById: vi.fn<() => Promise<Project | null>>(),
  };

  const recovery = {
    recoverStaleRunningAgentSessions: vi.fn<() => Promise<number>>(),
  };

  const repository = new SessionRepository(
    unsafeCoerce<ConstructorParameters<typeof SessionRepository>[0]>(sessions),
    workspaces,
    projects,
    recovery
  );

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows first non-null providerSessionId assignment', async () => {
    sessions.findById.mockResolvedValue(createSession({ providerSessionId: null }));
    sessions.update.mockResolvedValue(createSession({ providerSessionId: 'provider-1' }));

    const updated = await repository.updateSession('s1', { providerSessionId: 'provider-1' });

    expect(updated.providerSessionId).toBe('provider-1');
    expect(sessions.update).toHaveBeenCalledWith('s1', { providerSessionId: 'provider-1' });
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

  it('delegates stale running session recovery to the session accessor', async () => {
    recovery.recoverStaleRunningAgentSessions.mockResolvedValue(3);

    await expect(repository.recoverStaleRunningSessions()).resolves.toBe(3);

    expect(recovery.recoverStaleRunningAgentSessions).toHaveBeenCalledOnce();
  });

  it('delegates conditional session updates to the session accessor', async () => {
    sessions.updateIfStatus.mockResolvedValue(1);

    await expect(
      repository.updateSessionIfStatus('s1', { status: 'IDLE' }, ['RUNNING'])
    ).resolves.toBe(1);

    expect(sessions.updateIfStatus).toHaveBeenCalledWith('s1', { status: 'IDLE' }, ['RUNNING']);
  });
});
