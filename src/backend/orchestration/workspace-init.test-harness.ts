vi.mock('./pr-monitoring.orchestrator', () => ({ bindIssueMonitoringSession: vi.fn() }));

import { type Mock, vi } from 'vitest';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';

export const mockWorkspaceUpdate: Mock = vi.fn();
export const mockLogger: Record<'debug' | 'info' | 'warn' | 'error', Mock> = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

// --- Module mocks (before imports) ---

vi.mock('@/backend/services/github', () => ({
  githubCLIService: {
    getAuthenticatedUsername: vi.fn(),
    getIssue: vi.fn(),
  },
}));

vi.mock('@/backend/services/run-script', () => ({
  startupScriptService: {
    hasStartupScript: vi.fn(),
    runStartupScript: vi.fn(),
  },
  FactoryConfigService: {
    readConfig: vi.fn(),
  },
  runScriptConfigPersistenceService: {
    syncWorkspaceCommandsFromFactoryConfig: vi.fn(),
  },
}));

vi.mock('@/backend/services/session', () => ({
  buildChildWorkspaceContext: vi.fn(
    (input: { reportBackOn?: string | null }) =>
      `## Child Workspace Context\nUse send_message_to_parent.${input.reportBackOn ? `\nReport back when: ${input.reportBackOn}` : ''}\n`
  ),
  chatMessageHandlerService: {
    tryDispatchNextMessage: vi.fn(),
  },
  sessionDataService: {
    findAgentSessionsByWorkspaceId: vi.fn(),
  },
  sessionDomainService: {
    enqueue: vi.fn(),
    emitDelta: vi.fn(),
  },
  sessionLifecycleService: {
    startSession: vi.fn(),
    stopWorkspaceSessions: vi.fn(),
  },
}));

vi.mock('@/backend/services/terminal', () => ({
  terminalService: {
    createTerminal: vi.fn(),
    destroyTerminal: vi.fn(),
    getTerminalsForWorkspace: vi.fn(),
    onExit: vi.fn(),
  },
  terminalSessionService: {
    registerSession: vi.fn(),
    releaseSessionPid: vi.fn(),
  },
}));

vi.mock('@/backend/services/workspace', () => ({
  assertWorktreePathSafe: vi.fn(),
  workspaceStateMachine: {
    startProvisioning: vi.fn(),
    markFailed: vi.fn(),
    markReady: vi.fn(),
    markReadyWithWarning: vi.fn(),
  },
  worktreeLifecycleService: {
    prepareStaleProvisioningRecovery: vi.fn(),
    getInitMode: vi.fn(),
    clearInitMode: vi.fn(),
  },
  workspaceDataService: {
    findById: vi.fn(),
    findByIdWithProject: vi.fn(),
  },
  workspaceRelationshipsService: {
    findParent: vi.fn(),
  },
  workspaceRunScriptService: {
    registerInitializedWorktree: (...args: unknown[]) => mockWorkspaceUpdate(...args),
    setCommands: (...args: unknown[]) => mockWorkspaceUpdate(...args),
  },
  gitOpsService: {
    ensureBaseBranchExists: vi.fn(),
    createWorktree: vi.fn(),
    createWorktreeFromExistingBranch: vi.fn(),
    removeWorktree: vi.fn(),
  },
}));

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => mockLogger,
}));

vi.mock('@/shared/acp-protocol', () => ({
  MessageState: { ACCEPTED: 'ACCEPTED' },
  resolveSelectedModel: vi.fn((m: string) => m ?? 'claude-sonnet'),
}));

// --- Imports (after mocks) ---

import { githubCLIService } from '@/backend/services/github';
import {
  FactoryConfigService,
  runScriptConfigPersistenceService,
  startupScriptService,
} from '@/backend/services/run-script';
import {
  chatMessageHandlerService,
  sessionDataService,
  sessionLifecycleService,
} from '@/backend/services/session';
import { terminalService, terminalSessionService } from '@/backend/services/terminal';
import {
  gitOpsService,
  workspaceDataService,
  workspaceStateMachine,
  worktreeLifecycleService,
} from '@/backend/services/workspace';

export const WORKSPACE_ID = 'ws-1';

export function makeWorkspaceWithProject(overrides = {}) {
  return unsafeCoerce<
    NonNullable<Awaited<ReturnType<typeof workspaceDataService.findByIdWithProject>>>
  >({
    id: WORKSPACE_ID,
    name: 'test-workspace',
    status: 'NEW',
    githubIssueNumber: null,
    githubIssueUrl: null,
    project: {
      id: 'proj-1',
      repoPath: '/repo',
      defaultBranch: 'main',
      worktreeBasePath: '/worktrees',
      githubOwner: 'owner',
      githubRepo: 'repo',
      startupScriptCommand: null,
      startupScriptPath: null,
    },
    ...overrides,
  });
}

export function setupHappyPath(overrides = {}) {
  const workspace = makeWorkspaceWithProject(overrides);
  vi.mocked(workspaceStateMachine.startProvisioning).mockResolvedValue(unsafeCoerce(workspace));
  vi.mocked(workspaceDataService.findByIdWithProject).mockResolvedValue(workspace);
  vi.mocked(workspaceDataService.findById).mockResolvedValue(workspace as never);
  vi.mocked(mockWorkspaceUpdate).mockResolvedValue(workspace as never);
  vi.mocked(gitOpsService.ensureBaseBranchExists).mockResolvedValue(undefined);
  vi.mocked(gitOpsService.removeWorktree).mockResolvedValue(undefined);
  vi.mocked(gitOpsService.createWorktree).mockResolvedValue({
    worktreePath: '/worktrees/workspace-ws-1',
    branchName: 'user/test-workspace',
  });
  vi.mocked(gitOpsService.createWorktreeFromExistingBranch).mockResolvedValue({
    worktreePath: '/worktrees/workspace-ws-1',
    branchName: 'existing-branch',
  });
  vi.mocked(FactoryConfigService.readConfig).mockResolvedValue(null);
  vi.mocked(startupScriptService.hasStartupScript).mockReturnValue(false);
  vi.mocked(worktreeLifecycleService.getInitMode).mockResolvedValue(undefined);
  vi.mocked(worktreeLifecycleService.clearInitMode).mockResolvedValue(undefined);
  vi.mocked(
    runScriptConfigPersistenceService.syncWorkspaceCommandsFromFactoryConfig
  ).mockImplementation(async (input) => {
    const commands = {
      runScriptCommand: input.factoryConfig?.scripts.run ?? null,
      runScriptPostRunCommand: input.factoryConfig?.scripts.postRun ?? null,
      runScriptCleanupCommand: input.factoryConfig?.scripts.cleanup ?? null,
    };
    await input.persistWorkspaceCommands(input.workspaceId, commands);
    return commands;
  });
  vi.mocked(workspaceStateMachine.markReady).mockResolvedValue(unsafeCoerce(workspace));
  vi.mocked(workspaceStateMachine.markReadyWithWarning).mockResolvedValue(unsafeCoerce(workspace));
  vi.mocked(workspaceStateMachine.markFailed).mockResolvedValue(unsafeCoerce(workspace));
  vi.mocked(githubCLIService.getAuthenticatedUsername).mockResolvedValue('testuser');
  vi.mocked(sessionDataService.findAgentSessionsByWorkspaceId).mockResolvedValue([]);
  vi.mocked(sessionLifecycleService.stopWorkspaceSessions).mockResolvedValue(undefined as never);
  vi.mocked(sessionLifecycleService.startSession).mockResolvedValue(undefined as never);
  vi.mocked(chatMessageHandlerService.tryDispatchNextMessage).mockResolvedValue(undefined as never);
  vi.mocked(terminalSessionService.registerSession).mockResolvedValue(unsafeCoerce({}));
  vi.mocked(terminalSessionService.releaseSessionPid).mockResolvedValue(undefined);
  vi.mocked(terminalService.createTerminal).mockResolvedValue({
    terminalId: 'term-default',
    pid: 12_345,
  });
  vi.mocked(terminalService.destroyTerminal).mockReturnValue(true);
  vi.mocked(terminalService.getTerminalsForWorkspace).mockReturnValue([]);
  vi.mocked(terminalService.onExit).mockImplementation(() => vi.fn());
  return workspace;
}
