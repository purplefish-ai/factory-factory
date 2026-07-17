import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agentSessionAccessor } from '@/backend/services/session/resources/agent-session.accessor';
import { sessionDataService } from './session-data.service';
import { sessionProviderResolverService } from './session-provider-resolver.service';

vi.mock('@/backend/services/session/resources/agent-session.accessor', () => ({
  agentSessionAccessor: {
    acquireFixerSession: vi.fn(),
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
});
