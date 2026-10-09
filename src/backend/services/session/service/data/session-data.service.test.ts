import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agentSessionAccessor } from '@/backend/services/session/resources/agent-session.accessor';
import { sessionBackgroundDeliveryService } from '@/backend/services/session/service/lifecycle/session-background-delivery.service';
import { createLifecycleTestSession } from '@/backend/services/session/service/lifecycle/session-lifecycle.test-helpers';
import { sessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { sessionDataService } from './session-data.service';

vi.mock('@/backend/services/session/resources/agent-session.accessor', () => ({
  agentSessionAccessor: {
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
    const resumeGuard = sessionBackgroundDeliveryService.captureResumeGuard('session-1');
    sessionDomainService.resetProviderHistory('session-1', 'new');
    sessionDomainService.clearSession('session-1');
    vi.mocked(agentSessionAccessor.delete).mockRejectedValueOnce(new Error('delete failed'));
    await expect(sessionDataService.deleteAgentSession('session-1')).rejects.toThrow(
      'delete failed'
    );
    expect(sessionDomainService.acceptProviderHistoryIdentity('session-1', 'old')).toBe(false);
    expect(resumeGuard()).toBe(true);
    vi.mocked(agentSessionAccessor.delete).mockResolvedValue(createLifecycleTestSession());
    await sessionDataService.deleteAgentSession('session-1');
    expect(sessionDomainService.acceptProviderHistoryIdentity('session-1', 'old')).toBe(true);
    expect(resumeGuard()).toBe(false);
  });

  it('maps persistence rows to capsule-owned session records', async () => {
    vi.mocked(agentSessionAccessor.findById).mockResolvedValue({
      id: 'session-1',
      workspaceId: 'workspace-1',
      name: 'Implement',
      workflow: 'implement',
      workspacePrId: 'pr-1',
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
      workspacePrId: 'pr-1',
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
