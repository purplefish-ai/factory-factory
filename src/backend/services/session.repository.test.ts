import type { ClaudeSession, Project, Workspace } from '@prisma-gen/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionRepository } from './session.repository';

const createSession = (overrides?: Partial<ClaudeSession>): ClaudeSession =>
  ({
    id: 's1',
    workspaceId: 'w1',
    name: null,
    workflow: 'default',
    model: 'sonnet',
    status: 'IDLE',
    claudeSessionId: null,
    claudeProjectPath: null,
    claudeProcessPid: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  }) as ClaudeSession;

describe('SessionRepository', () => {
  const sessions = {
    findById: vi.fn<() => Promise<ClaudeSession | null>>(),
    findByWorkspaceId: vi.fn<() => Promise<ClaudeSession[]>>(),
    update: vi.fn<() => Promise<ClaudeSession>>(),
    delete: vi.fn<() => Promise<ClaudeSession>>(),
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
    sessions as unknown as {
      findById(id: string): Promise<ClaudeSession | null>;
      findByWorkspaceId(workspaceId: string): Promise<ClaudeSession[]>;
      update(
        id: string,
        data: Partial<
          Pick<
            ClaudeSession,
            'status' | 'claudeProcessPid' | 'claudeSessionId' | 'claudeProjectPath'
          >
        >
      ): Promise<ClaudeSession>;
      delete(id: string): Promise<ClaudeSession>;
    },
    workspaces,
    projects
  );

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows first non-null claudeSessionId assignment', async () => {
    sessions.findById.mockResolvedValue(createSession({ claudeSessionId: null }));
    sessions.update.mockResolvedValue(createSession({ claudeSessionId: 'claude-1' }));

    const updated = await repository.updateSession('s1', { claudeSessionId: 'claude-1' });

    expect(updated.claudeSessionId).toBe('claude-1');
    expect(sessions.update).toHaveBeenCalledWith('s1', { claudeSessionId: 'claude-1' });
  });

  it('allows idempotent re-write of same claudeSessionId', async () => {
    sessions.findById.mockResolvedValue(createSession({ claudeSessionId: 'claude-1' }));
    sessions.update.mockResolvedValue(createSession({ claudeSessionId: 'claude-1' }));

    await repository.updateSession('s1', { claudeSessionId: 'claude-1' });

    expect(sessions.update).toHaveBeenCalledWith('s1', { claudeSessionId: 'claude-1' });
  });

  it('rejects changing an existing claudeSessionId', async () => {
    sessions.findById.mockResolvedValue(createSession({ claudeSessionId: 'claude-1' }));

    await expect(repository.updateSession('s1', { claudeSessionId: 'claude-2' })).rejects.toThrow(
      /immutable/
    );
    expect(sessions.update).not.toHaveBeenCalled();
  });

  it('rejects clearing an existing claudeSessionId', async () => {
    sessions.findById.mockResolvedValue(createSession({ claudeSessionId: 'claude-1' }));

    await expect(repository.updateSession('s1', { claudeSessionId: null })).rejects.toThrow(
      /immutable/
    );
    expect(sessions.update).not.toHaveBeenCalled();
  });
});
