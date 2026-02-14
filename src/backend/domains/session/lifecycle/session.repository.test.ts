import type { Project, Workspace } from '@prisma-gen/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSessionRecord } from '@/backend/resource_accessors/agent-session.accessor';
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
    delete: vi.fn<() => Promise<AgentSessionRecord>>(),
  };

  const workspaces = {
    findById: vi.fn<() => Promise<Workspace | null>>(),
    markHasHadSessions: vi.fn<() => Promise<void>>(),
    clearRatchetActiveSession: vi.fn<() => Promise<void>>(),
  };

  const projects = {
    findById: vi.fn<() => Promise<Project | null>>(),
  };

  const repository = new SessionRepository(
    unsafeCoerce<ConstructorParameters<typeof SessionRepository>[0]>(sessions),
    workspaces,
    projects
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
});
