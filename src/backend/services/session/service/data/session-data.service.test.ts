import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agentSessionAccessor } from '@/backend/services/session/resources/agent-session.accessor';
import { createLifecycleTestSession } from '@/backend/services/session/service/lifecycle/session-lifecycle.test-helpers';
import { sessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { sessionDataService } from './session-data.service';
import { sessionProviderResolverService } from './session-provider-resolver.service';

vi.mock('@/backend/services/session/resources/agent-session.accessor', () => ({
  agentSessionAccessor: {
    acquireFixerSession: vi.fn(),
    findById: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('./session-provider-resolver.service', () => ({
  sessionProviderResolverService: {
    resolveSessionDefaults: vi.fn(),
  },
}));

describe('sessionDataService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionDomainService.clearAllSessions();
  });

  it('reclaims the history identity fence after permanent deletion, but retains it on failure', async () => {
    sessionDomainService.resetProviderHistory('session-1', 'new');
    sessionDomainService.clearSession('session-1');
    vi.mocked(agentSessionAccessor.delete).mockRejectedValueOnce(new Error('delete failed'));
    await expect(sessionDataService.deleteAgentSession('session-1')).rejects.toThrow(
      'delete failed'
    );
    expect(sessionDomainService.acceptProviderHistoryIdentity('session-1', 'old')).toBe(false);
    vi.mocked(agentSessionAccessor.delete).mockResolvedValue(createLifecycleTestSession());
    await sessionDataService.deleteAgentSession('session-1');
    expect(sessionDomainService.acceptProviderHistoryIdentity('session-1', 'old')).toBe(true);
  });

  it('resolves provider and model defaults before atomic fixer acquisition', async () => {
    vi.mocked(sessionProviderResolverService.resolveSessionDefaults).mockResolvedValue({
      provider: 'CODEX',
      model: 'gpt-5.3-codex',
    });
    vi.mocked(agentSessionAccessor.acquireFixerSession).mockResolvedValue({
      outcome: 'created',
      sessionId: 'session-1',
    });

    await expect(
      sessionDataService.acquireFixerSession({
        workspaceId: 'workspace-1',
        workflow: 'ci-fix',
        sessionName: 'CI Fixing',
        maxSessions: 5,
        providerProjectPath: null,
      })
    ).resolves.toEqual({ outcome: 'created', sessionId: 'session-1' });

    expect(sessionProviderResolverService.resolveSessionDefaults).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      explicitProvider: undefined,
    });
    expect(agentSessionAccessor.acquireFixerSession).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      workflow: 'ci-fix',
      sessionName: 'CI Fixing',
      maxSessions: 5,
      provider: 'CODEX',
      model: 'gpt-5.3-codex',
      providerProjectPath: null,
    });
  });

  it('maps persistence rows to capsule-owned session records', async () => {
    vi.mocked(agentSessionAccessor.findById).mockResolvedValue({
      id: 'session-1',
      workspaceId: 'workspace-1',
      name: 'Implement',
      workflow: 'implement',
      model: 'gpt-5.3-codex',
      status: 'IDLE',
      provider: 'CODEX',
      providerSessionId: null,
      providerProjectPath: null,
      providerProcessPid: null,
      providerMetadata: null,
      createdAt: new Date('2026-07-17T00:00:00.000Z'),
      updatedAt: new Date('2026-07-17T00:00:00.000Z'),
      workspace: {
        status: 'READY',
        worktreePath: '/tmp/worktree',
        initErrorMessage: null,
      },
    } as never);

    await expect(sessionDataService.findAgentSessionById('session-1')).resolves.toEqual({
      id: 'session-1',
      workspaceId: 'workspace-1',
      name: 'Implement',
      workflow: 'implement',
      model: 'gpt-5.3-codex',
      status: 'IDLE',
      provider: 'CODEX',
      providerSessionId: null,
      providerProjectPath: null,
      providerProcessPid: null,
      providerMetadata: null,
      createdAt: new Date('2026-07-17T00:00:00.000Z'),
      updatedAt: new Date('2026-07-17T00:00:00.000Z'),
      workspace: {
        status: 'READY',
        worktreePath: '/tmp/worktree',
        initErrorMessage: null,
      },
    });
  });

  it('returns null when the persistence session does not exist', async () => {
    vi.mocked(agentSessionAccessor.findById).mockResolvedValue(null);

    await expect(sessionDataService.findAgentSessionById('missing-session')).resolves.toBeNull();
  });
});
