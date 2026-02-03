import { SessionStatus } from '@prisma-gen/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./logger.service', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('./session.repository', () => ({
  SessionRepository: class {},
  sessionRepository: {
    getSessionById: vi.fn(),
    getSessionsByWorkspaceId: vi.fn(),
    getWorkspaceById: vi.fn(),
    getProjectById: vi.fn(),
    markWorkspaceHasHadSessions: vi.fn(),
    updateSession: vi.fn(),
  },
}));

vi.mock('./session.prompt-builder', () => ({
  SessionPromptBuilder: class {},
  sessionPromptBuilder: {
    shouldInjectBranchRename: vi.fn(),
    buildSystemPrompt: vi.fn(),
  },
}));

vi.mock('./session.process-manager', () => ({
  SessionProcessManager: class {},
  sessionProcessManager: {
    setOnClientCreated: vi.fn(),
    isStopInProgress: vi.fn(),
    createClient: vi.fn(),
    getOrCreateClient: vi.fn(),
    getClient: vi.fn(),
    stopClient: vi.fn(),
    getClaudeProcess: vi.fn(),
    isSessionRunning: vi.fn(),
    isSessionWorking: vi.fn(),
    isAnySessionWorking: vi.fn(),
    getAllActiveProcesses: vi.fn(),
    getAllClients: vi.fn(),
    stopAllClients: vi.fn(),
  },
}));

import { sessionProcessManager } from './session.process-manager';
import { sessionPromptBuilder } from './session.prompt-builder';
import { sessionRepository } from './session.repository';
import { sessionService } from './session.service';

describe('SessionService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts a session via process manager and updates DB state', async () => {
    const session = {
      id: 'session-1',
      workspaceId: 'workspace-1',
      status: SessionStatus.IDLE,
      workflow: 'default',
      model: 'sonnet',
      claudeSessionId: null,
    } as unknown as NonNullable<Awaited<ReturnType<typeof sessionRepository.getSessionById>>>;

    const workspace = {
      id: 'workspace-1',
      worktreePath: '/tmp/work',
      branchName: 'auto-branch',
      name: 'Workspace A',
      description: null,
      projectId: 'project-1',
    } as unknown as Awaited<ReturnType<typeof sessionRepository.getWorkspaceById>>;

    const project = {
      id: 'project-1',
      githubOwner: 'owner',
    } as unknown as Awaited<ReturnType<typeof sessionRepository.getProjectById>>;

    const client = {
      getPid: vi.fn().mockReturnValue(123),
    } as unknown as Awaited<ReturnType<typeof sessionProcessManager.createClient>>;

    vi.mocked(sessionRepository.getSessionById).mockResolvedValue(session);
    vi.mocked(sessionRepository.getWorkspaceById).mockResolvedValue(workspace);
    vi.mocked(sessionRepository.getProjectById).mockResolvedValue(project);
    vi.mocked(sessionRepository.markWorkspaceHasHadSessions).mockResolvedValue();
    vi.mocked(sessionRepository.updateSession).mockResolvedValue(session);

    vi.mocked(sessionPromptBuilder.shouldInjectBranchRename).mockReturnValue(true);
    vi.mocked(sessionPromptBuilder.buildSystemPrompt).mockReturnValue({
      workflowPrompt: 'workflow',
      systemPrompt: 'system',
      injectedBranchRename: true,
    });

    vi.mocked(sessionProcessManager.isStopInProgress).mockReturnValue(false);
    vi.mocked(sessionProcessManager.createClient).mockResolvedValue(client);

    await sessionService.startClaudeSession('session-1', { initialPrompt: 'Hello' });

    expect(sessionRepository.markWorkspaceHasHadSessions).toHaveBeenCalledWith('workspace-1');
    expect(sessionProcessManager.createClient).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        workingDir: '/tmp/work',
        systemPrompt: 'system',
        model: 'sonnet',
        permissionMode: 'bypassPermissions',
        includePartialMessages: true,
        initialPrompt: 'Hello',
        sessionId: 'session-1',
      }),
      expect.any(Object),
      { workspaceId: 'workspace-1', workingDir: '/tmp/work' }
    );
    expect(sessionRepository.updateSession).toHaveBeenCalledWith('session-1', {
      status: SessionStatus.RUNNING,
      claudeProcessPid: 123,
    });
  });

  it('returns null session options when workspace is missing', async () => {
    const session = {
      id: 'session-1',
      workspaceId: 'workspace-1',
      status: SessionStatus.IDLE,
      workflow: 'default',
      model: 'sonnet',
      claudeSessionId: null,
    } as unknown as Awaited<ReturnType<typeof sessionRepository.getSessionById>>;

    vi.mocked(sessionRepository.getSessionById).mockResolvedValue(session);
    vi.mocked(sessionRepository.getWorkspaceById).mockResolvedValue(null);

    const options = await sessionService.getSessionOptions('session-1');

    expect(options).toBeNull();
  });
});
