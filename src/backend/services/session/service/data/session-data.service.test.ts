import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agentSessionAccessor } from '@/backend/services/session/resources/agent-session.accessor';
import { sessionDataService } from './session-data.service';
import { sessionProviderResolverService } from './session-provider-resolver.service';

vi.mock('@/backend/services/session/resources/agent-session.accessor', () => ({
  agentSessionAccessor: {
    acquireFixerSession: vi.fn(),
    findById: vi.fn(),
    recoverStaleRunning: vi.fn(),
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

  it('recovers stale running agent sessions through the session boundary', async () => {
    vi.mocked(agentSessionAccessor.recoverStaleRunning).mockResolvedValue(3);

    await expect(sessionDataService.recoverStaleRunningAgentSessions()).resolves.toBe(3);

    expect(agentSessionAccessor.recoverStaleRunning).toHaveBeenCalledOnce();
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
});
