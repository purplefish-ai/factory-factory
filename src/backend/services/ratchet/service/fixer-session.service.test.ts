import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionStatus } from '@/shared/core';
import type { RatchetSessionBridge, RatchetWorkspaceBridge } from './bridges';

vi.mock('@/backend/services/workspace', () => ({
  workspaceDataService: {
    findById: vi.fn(),
  },
}));

vi.mock('@/backend/services/session', () => ({
  sessionDataService: {
    findAgentSessionsByWorkspaceId: vi.fn(),
    acquireFixerSession: vi.fn(),
  },
}));

vi.mock('@/backend/services/settings', () => ({
  userSettingsService: {
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

import { configService } from '@/backend/services/config.service';
import { userSettingsService } from '@/backend/services/settings';
import { fixerSessionService } from './fixer-session.service';

const mockSessionBridge: RatchetSessionBridge = {
  findSessionById: vi.fn(),
  findSessionsByWorkspaceId: vi.fn(),
  acquireFixerSession: vi.fn(),
  isSessionRunning: vi.fn(),
  isSessionWorking: vi.fn(),
  stopSession: vi.fn(),
  startSession: vi.fn(),
  restartSession: vi.fn(),
  sendSessionMessage: vi.fn(),
  injectCommittedUserMessage: vi.fn(),
};

const mockWorkspaceBridge: RatchetWorkspaceBridge = {
  findFixerContext: vi.fn(),
  recordSessionEnd: vi.fn(),
};

describe('FixerSessionService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fixerSessionService.configure({ session: mockSessionBridge, workspace: mockWorkspaceBridge });
    vi.mocked(mockWorkspaceBridge.findFixerContext).mockResolvedValue({
      id: 'w1',
      defaultSessionProvider: 'WORKSPACE_DEFAULT',
      ratchetSessionProvider: 'WORKSPACE_DEFAULT',
    } as never);
    vi.mocked(userSettingsService.get).mockResolvedValue({
      defaultSessionProvider: 'CLAUDE',
    } as never);
    vi.mocked(userSettingsService.getDefaultSessionProvider).mockResolvedValue('CLAUDE');
  });

  it('skips when workspace is missing worktree', async () => {
    vi.mocked(mockWorkspaceBridge.findFixerContext).mockResolvedValue(null);

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
    vi.mocked(mockWorkspaceBridge.findFixerContext).mockResolvedValue({
      worktreePath: '/tmp/w',
    } as never);
    vi.mocked(mockSessionBridge.acquireFixerSession).mockResolvedValue({
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
    vi.mocked(mockWorkspaceBridge.findFixerContext).mockResolvedValue({
      worktreePath: '/tmp/w',
    } as never);
    vi.mocked(mockSessionBridge.acquireFixerSession).mockResolvedValue({
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
    vi.mocked(mockWorkspaceBridge.findFixerContext).mockResolvedValue({
      worktreePath: '/tmp/w',
    } as never);
    vi.mocked(mockSessionBridge.acquireFixerSession).mockResolvedValue({
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
      startupModePreset: 'non_interactive',
    });
  });

  it('returns after initiating a prompt without waiting for the agent turn', async () => {
    vi.mocked(mockWorkspaceBridge.findFixerContext).mockResolvedValue({
      worktreePath: '/tmp/w',
    } as never);
    vi.mocked(mockSessionBridge.acquireFixerSession).mockResolvedValue({
      outcome: 'created',
      sessionId: 's-deferred',
    });
    vi.mocked(configService.getMaxSessionsPerWorkspace).mockReturnValue(5);
    vi.mocked(mockSessionBridge.startSession).mockResolvedValue(undefined);
    vi.mocked(mockSessionBridge.isSessionRunning).mockReturnValue(true);

    let finishPrompt!: () => void;
    vi.mocked(mockSessionBridge.sendSessionMessage).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishPrompt = resolve;
        })
    );

    let acquisitionSettled = false;
    const acquisition = fixerSessionService
      .acquireAndDispatch({
        workspaceId: 'w1',
        workflow: 'ratchet',
        sessionName: 'Ratchet',
        runningIdleAction: 'restart',
        dispatchMode: 'start_empty_and_send',
        buildPrompt: () => 'prompt',
      })
      .then((result) => {
        acquisitionSettled = true;
        return result;
      });

    await vi.waitFor(() => expect(mockSessionBridge.sendSessionMessage).toHaveBeenCalled());
    await Promise.resolve();
    const settledBeforeTurnCompletion = acquisitionSettled;
    finishPrompt();
    const result = await acquisition;

    expect(settledBeforeTurnCompletion).toBe(true);
    expect(result).toMatchObject({
      status: 'started',
      sessionId: 's-deferred',
      promptSent: true,
    });
    const startedResult = result as Extract<typeof result, { status: 'started' }>;
    await expect(startedResult.promptCompletion).resolves.toBe(true);
  });

  it('calls afterStart after startup and before awaiting the agent turn', async () => {
    vi.mocked(mockWorkspaceBridge.findFixerContext).mockResolvedValue({
      worktreePath: '/tmp/w',
    } as never);
    vi.mocked(mockSessionBridge.acquireFixerSession).mockResolvedValue({
      outcome: 'created',
      sessionId: 's-new',
    });
    vi.mocked(configService.getMaxSessionsPerWorkspace).mockReturnValue(5);

    const events: string[] = [];
    let finishTurn!: () => void;
    vi.mocked(mockSessionBridge.startSession).mockImplementation(() => {
      events.push('started');
      return Promise.resolve();
    });
    vi.mocked(mockSessionBridge.isSessionRunning).mockReturnValue(true);
    vi.mocked(mockSessionBridge.sendSessionMessage).mockImplementation(async () => {
      events.push('turn-started');
      await new Promise<void>((resolve) => {
        finishTurn = resolve;
      });
    });

    const dispatch = fixerSessionService.acquireAndDispatch({
      workspaceId: 'w1',
      workflow: 'ratchet',
      sessionName: 'Ratchet',
      runningIdleAction: 'restart',
      dispatchMode: 'start_empty_and_send',
      buildPrompt: () => 'prompt',
      afterStart: () => {
        events.push('after-start');
      },
    });

    await vi.waitFor(() => expect(mockSessionBridge.sendSessionMessage).toHaveBeenCalled());
    finishTurn();

    const result = await dispatch;
    expect(result).toMatchObject({
      status: 'started',
      sessionId: 's-new',
      promptSent: true,
    });
    const startedResult = result as Extract<typeof result, { status: 'started' }>;
    await expect(startedResult.promptCompletion).resolves.toBe(true);
    expect(events).toEqual(['started', 'after-start', 'turn-started']);
  });

  it('restarts an existing running idle session when configured', async () => {
    vi.mocked(mockWorkspaceBridge.findFixerContext).mockResolvedValue({
      worktreePath: '/tmp/w',
    } as never);
    vi.mocked(mockSessionBridge.acquireFixerSession).mockResolvedValue({
      outcome: 'existing',
      sessionId: 's-running',
      status: SessionStatus.RUNNING,
    });

    vi.mocked(mockSessionBridge.isSessionWorking).mockReturnValue(false);
    vi.mocked(mockSessionBridge.restartSession).mockResolvedValue(undefined);

    const result = await fixerSessionService.acquireAndDispatch({
      workspaceId: 'w1',
      workflow: 'ci-fix',
      sessionName: 'CI Fixing',
      runningIdleAction: 'restart',
      buildPrompt: () => 'fix the failing checks',
    });

    expect(result).toEqual({ status: 'started', sessionId: 's-running' });
    expect(mockSessionBridge.restartSession).toHaveBeenCalledWith('s-running', {
      initialPrompt: 'fix the failing checks',
      startupModePreset: 'non_interactive',
    });
    expect(mockSessionBridge.startSession).not.toHaveBeenCalled();
  });

  it('does not set providerProjectPath when resolved provider is CODEX', async () => {
    vi.mocked(mockWorkspaceBridge.findFixerContext).mockResolvedValue({
      id: 'w1',
      worktreePath: '/tmp/w',
      defaultSessionProvider: 'CODEX',
      ratchetSessionProvider: 'WORKSPACE_DEFAULT',
    } as never);
    vi.mocked(configService.getMaxSessionsPerWorkspace).mockReturnValue(5);
    vi.mocked(mockSessionBridge.acquireFixerSession).mockResolvedValue({
      outcome: 'limit_reached',
    });

    await fixerSessionService.acquireAndDispatch({
      workspaceId: 'w1',
      workflow: 'ci-fix',
      sessionName: 'CI Fixing',
      runningIdleAction: 'send_message',
      buildPrompt: () => 'prompt',
    });

    expect(mockSessionBridge.acquireFixerSession).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'CODEX',
        providerProjectPath: null,
      })
    );
  });

  it('deduplicates concurrent acquisition by workspace/workflow', async () => {
    vi.mocked(mockWorkspaceBridge.findFixerContext).mockResolvedValue({
      worktreePath: '/tmp/w',
    } as never);
    vi.mocked(mockSessionBridge.acquireFixerSession).mockImplementation(async () => {
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
    expect(mockSessionBridge.acquireFixerSession).toHaveBeenCalledTimes(1);
  });

  it('returns latest active session for workflow', async () => {
    vi.mocked(mockSessionBridge.findSessionsByWorkspaceId).mockResolvedValue([
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
