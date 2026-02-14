import { SessionStatus } from '@factory-factory/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RatchetSessionBridge } from './bridges';

vi.mock('@/backend/resource_accessors/workspace.accessor', () => ({
  workspaceAccessor: {
    findById: vi.fn(),
    findRawById: vi.fn(),
  },
}));

vi.mock('@/backend/resource_accessors/agent-session.accessor', () => ({
  agentSessionAccessor: {
    findByWorkspaceId: vi.fn(),
    acquireFixerSession: vi.fn(),
  },
}));

vi.mock('@/backend/resource_accessors/user-settings.accessor', () => ({
  userSettingsAccessor: {
    get: vi.fn(),
    getDefaultSessionProvider: vi.fn(),
  },
}));

vi.mock('@/backend/services/config.service', () => ({
  configService: {
    getMaxSessionsPerWorkspace: vi.fn(),
  },
}));

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { agentSessionAccessor } from '@/backend/resource_accessors/agent-session.accessor';
import { userSettingsAccessor } from '@/backend/resource_accessors/user-settings.accessor';
import { workspaceAccessor } from '@/backend/resource_accessors/workspace.accessor';
import { configService } from '@/backend/services/config.service';
import { fixerSessionService } from './fixer-session.service';

const mockSessionBridge: RatchetSessionBridge = {
  isSessionRunning: vi.fn(),
  isSessionWorking: vi.fn(),
  stopSession: vi.fn(),
  startSession: vi.fn(),
  sendSessionMessage: vi.fn(),
  injectCommittedUserMessage: vi.fn(),
};

describe('FixerSessionService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fixerSessionService.configure({ session: mockSessionBridge });
    vi.mocked(workspaceAccessor.findRawById).mockResolvedValue({
      id: 'w1',
      defaultSessionProvider: 'WORKSPACE_DEFAULT',
      ratchetSessionProvider: 'WORKSPACE_DEFAULT',
    } as never);
    vi.mocked(userSettingsAccessor.get).mockResolvedValue({
      defaultSessionProvider: 'CLAUDE',
    } as never);
    vi.mocked(userSettingsAccessor.getDefaultSessionProvider).mockResolvedValue('CLAUDE');
  });

  it('skips when workspace is missing worktree', async () => {
    vi.mocked(workspaceAccessor.findById).mockResolvedValue(null);

    const result = await fixerSessionService.acquireAndDispatch({
      workspaceId: 'w1',
      workflow: 'ci-fix',
      sessionName: 'CI Fixing',
      runningIdleAction: 'send_message',
      buildPrompt: () => 'hello',
    });

    expect(result).toEqual({
      status: 'skipped',
      reason: 'Workspace not ready (no worktree path)',
    });
  });

  it('returns already_active when existing session is actively working', async () => {
    vi.mocked(workspaceAccessor.findById).mockResolvedValue({ worktreePath: '/tmp/w' } as never);
    vi.mocked(agentSessionAccessor.acquireFixerSession).mockResolvedValue({
      outcome: 'existing',
      sessionId: 's1',
      status: SessionStatus.RUNNING,
    });

    vi.mocked(mockSessionBridge.isSessionWorking).mockReturnValue(true);

    const result = await fixerSessionService.acquireAndDispatch({
      workspaceId: 'w1',
      workflow: 'ci-fix',
      sessionName: 'CI Fixing',
      runningIdleAction: 'send_message',
      buildPrompt: () => 'hello',
    });

    expect(result).toEqual({ status: 'already_active', sessionId: 's1', reason: 'working' });
  });

  it('sends message to running idle session when configured', async () => {
    vi.mocked(workspaceAccessor.findById).mockResolvedValue({ worktreePath: '/tmp/w' } as never);
    vi.mocked(agentSessionAccessor.acquireFixerSession).mockResolvedValue({
      outcome: 'existing',
      sessionId: 's1',
      status: SessionStatus.RUNNING,
    });

    vi.mocked(mockSessionBridge.isSessionWorking).mockReturnValue(false);
    vi.mocked(mockSessionBridge.isSessionRunning).mockReturnValue(true);
    vi.mocked(mockSessionBridge.sendSessionMessage).mockResolvedValue(undefined);

    const result = await fixerSessionService.acquireAndDispatch({
      workspaceId: 'w1',
      workflow: 'ci-fix',
      sessionName: 'CI Fixing',
      runningIdleAction: 'send_message',
      buildPrompt: () => 'prompt',
    });

    expect(result).toEqual({
      status: 'already_active',
      sessionId: 's1',
      reason: 'message_dispatched',
    });
    expect(mockSessionBridge.sendSessionMessage).toHaveBeenCalledWith('s1', 'prompt');
  });

  it('creates and starts a new session', async () => {
    vi.mocked(workspaceAccessor.findById).mockResolvedValue({ worktreePath: '/tmp/w' } as never);
    vi.mocked(agentSessionAccessor.acquireFixerSession).mockResolvedValue({
      outcome: 'created',
      sessionId: 's-new',
    });

    vi.mocked(configService.getMaxSessionsPerWorkspace).mockReturnValue(5);
    vi.mocked(mockSessionBridge.startSession).mockResolvedValue(undefined);

    const result = await fixerSessionService.acquireAndDispatch({
      workspaceId: 'w1',
      workflow: 'ci-fix',
      sessionName: 'CI Fixing',
      runningIdleAction: 'send_message',
      buildPrompt: () => 'prompt',
    });

    expect(result).toEqual({ status: 'started', sessionId: 's-new' });
    expect(mockSessionBridge.startSession).toHaveBeenCalledWith('s-new', {
      initialPrompt: 'prompt',
    });
  });

  it('does not set claudeProjectPath when resolved provider is CODEX', async () => {
    vi.mocked(workspaceAccessor.findRawById).mockResolvedValue({
      id: 'w1',
      defaultSessionProvider: 'CODEX',
      ratchetSessionProvider: 'WORKSPACE_DEFAULT',
    } as never);
    vi.mocked(workspaceAccessor.findById).mockResolvedValue({ worktreePath: '/tmp/w' } as never);
    vi.mocked(configService.getMaxSessionsPerWorkspace).mockReturnValue(5);
    vi.mocked(agentSessionAccessor.acquireFixerSession).mockResolvedValue({
      outcome: 'limit_reached',
    });

    await fixerSessionService.acquireAndDispatch({
      workspaceId: 'w1',
      workflow: 'ci-fix',
      sessionName: 'CI Fixing',
      runningIdleAction: 'send_message',
      buildPrompt: () => 'prompt',
    });

    expect(agentSessionAccessor.acquireFixerSession).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'CODEX',
        claudeProjectPath: null,
      })
    );
  });

  it('deduplicates concurrent acquisition by workspace/workflow', async () => {
    vi.mocked(workspaceAccessor.findById).mockResolvedValue({ worktreePath: '/tmp/w' } as never);
    vi.mocked(agentSessionAccessor.acquireFixerSession).mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { outcome: 'created', sessionId: 's-new' };
    });

    vi.mocked(configService.getMaxSessionsPerWorkspace).mockReturnValue(5);
    vi.mocked(mockSessionBridge.startSession).mockResolvedValue(undefined);

    const [first, second] = await Promise.all([
      fixerSessionService.acquireAndDispatch({
        workspaceId: 'w1',
        workflow: 'ci-fix',
        sessionName: 'CI Fixing',
        runningIdleAction: 'send_message',
        buildPrompt: () => 'prompt',
      }),
      fixerSessionService.acquireAndDispatch({
        workspaceId: 'w1',
        workflow: 'ci-fix',
        sessionName: 'CI Fixing',
        runningIdleAction: 'send_message',
        buildPrompt: () => 'prompt',
      }),
    ]);

    expect(first).toEqual(second);
    expect(agentSessionAccessor.acquireFixerSession).toHaveBeenCalledTimes(1);
  });

  it('returns latest active session for workflow', async () => {
    vi.mocked(agentSessionAccessor.findByWorkspaceId).mockResolvedValue([
      {
        id: 'old',
        workflow: 'ci-fix',
        provider: 'CLAUDE',
        status: SessionStatus.RUNNING,
        createdAt: new Date('2025-01-01T00:00:00Z'),
      },
      {
        id: 'new',
        workflow: 'ci-fix',
        provider: 'CLAUDE',
        status: SessionStatus.IDLE,
        createdAt: new Date('2025-01-02T00:00:00Z'),
      },
    ] as never);

    const result = await fixerSessionService.getActiveSession('w1', 'ci-fix');
    expect(result).toEqual({ id: 'new', status: SessionStatus.IDLE });
  });
});
