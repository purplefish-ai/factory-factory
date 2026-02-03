/**
 * Tests for the CI Fixer Service.
 *
 * Tests the service that creates and manages dedicated Claude sessions to fix CI failures.
 */
import { SessionStatus } from '@prisma-gen/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock dependencies before importing the service
vi.mock('../db', () => ({
  prisma: {
    $transaction: vi.fn(),
  },
}));

vi.mock('../resource_accessors/workspace.accessor', () => ({
  workspaceAccessor: {
    findById: vi.fn(),
  },
}));

vi.mock('../resource_accessors/claude-session.accessor', () => ({
  claudeSessionAccessor: {
    findByWorkspaceId: vi.fn(),
  },
}));

vi.mock('./config.service', () => ({
  configService: {
    getMaxSessionsPerWorkspace: vi.fn(),
  },
}));

vi.mock('./session.service', () => ({
  sessionService: {
    isSessionWorking: vi.fn(),
    getClient: vi.fn(),
    startClaudeSession: vi.fn(),
  },
}));

vi.mock('./logger.service', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Import mocks after setup
import { prisma } from '../db';
import { claudeSessionAccessor } from '../resource_accessors/claude-session.accessor';
import { workspaceAccessor } from '../resource_accessors/workspace.accessor';
// Import the service (creates a fresh instance due to module reset)
import { ciFixerService } from './ci-fixer.service';
import { configService } from './config.service';
import { sessionService } from './session.service';

// =============================================================================
// Test Helpers
// =============================================================================

function createMockWorkspace(overrides: Partial<{ id: string; worktreePath: string | null }> = {}) {
  // Return minimal workspace object - workspaceAccessor.findById is mocked
  // so TypeScript inference doesn't apply at runtime.
  // Cast to unknown first then to the expected type to satisfy TypeScript
  return {
    id: 'workspace-1',
    worktreePath: '/path/to/worktree',
    ...overrides,
  } as unknown as Awaited<ReturnType<typeof workspaceAccessor.findById>>;
}

function createMockSession(
  overrides: Partial<{
    id: string;
    workspaceId: string;
    workflow: string;
    status: SessionStatus;
    model: string;
  }> = {}
) {
  // Return minimal session object with type cast for testing
  return {
    id: 'session-1',
    workspaceId: 'workspace-1',
    workflow: 'ci-fix',
    status: SessionStatus.IDLE,
    model: 'sonnet',
    name: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    claudeSessionId: null,
    claudeProcessPid: null,
    ...overrides,
  } as unknown as Awaited<ReturnType<typeof claudeSessionAccessor.findByWorkspaceId>>[number];
}

// Type for mocked Prisma transaction context
type MockTransactionContext = {
  claudeSession: {
    findFirst: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
};

function createMockTransactionContext(): MockTransactionContext {
  return {
    claudeSession: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
    },
  };
}

// Helper to create transaction mock implementation
function mockTransaction(txContext: MockTransactionContext) {
  // biome-ignore lint/suspicious/noExplicitAny: Mock implementation requires any for callback typing
  vi.mocked(prisma.$transaction).mockImplementation((callback: (tx: any) => Promise<unknown>) =>
    Promise.resolve(callback(txContext))
  );
}

// Helper to create slow transaction mock for race condition tests
function mockSlowTransaction(txContext: MockTransactionContext, delayMs: number) {
  vi.mocked(prisma.$transaction).mockImplementation(
    // biome-ignore lint/suspicious/noExplicitAny: Mock implementation requires any for callback typing
    async (callback: (tx: any) => Promise<unknown>) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return callback(txContext);
    }
  );
}

// =============================================================================
// Tests
// =============================================================================

describe('CIFixerService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // triggerCIFix - Workspace validation
  // ---------------------------------------------------------------------------

  describe('triggerCIFix - workspace validation', () => {
    it('should skip if workspace does not exist', async () => {
      vi.mocked(workspaceAccessor.findById).mockResolvedValue(null);

      const result = await ciFixerService.triggerCIFix({
        workspaceId: 'workspace-1',
        prUrl: 'https://github.com/org/repo/pull/123',
        prNumber: 123,
      });

      expect(result).toEqual({
        status: 'skipped',
        reason: 'Workspace not ready (no worktree path)',
      });
    });

    it('should skip if workspace has no worktree path', async () => {
      vi.mocked(workspaceAccessor.findById).mockResolvedValue(
        createMockWorkspace({ worktreePath: null })
      );

      const result = await ciFixerService.triggerCIFix({
        workspaceId: 'workspace-1',
        prUrl: 'https://github.com/org/repo/pull/123',
        prNumber: 123,
      });

      expect(result).toEqual({
        status: 'skipped',
        reason: 'Workspace not ready (no worktree path)',
      });
    });
  });

  // ---------------------------------------------------------------------------
  // triggerCIFix - Session creation
  // ---------------------------------------------------------------------------

  describe('triggerCIFix - session creation', () => {
    it('should create new session when none exists', async () => {
      vi.mocked(workspaceAccessor.findById).mockResolvedValue(createMockWorkspace());

      const txContext = createMockTransactionContext();
      txContext.claudeSession.findFirst.mockResolvedValue(null); // No existing CI fix session
      txContext.claudeSession.findMany.mockResolvedValue([]); // No sessions at all
      txContext.claudeSession.create.mockResolvedValue(createMockSession({ id: 'new-session-id' }));

      mockTransaction(txContext);

      vi.mocked(configService.getMaxSessionsPerWorkspace).mockReturnValue(10);
      vi.mocked(sessionService.startClaudeSession).mockResolvedValue(undefined);

      const result = await ciFixerService.triggerCIFix({
        workspaceId: 'workspace-1',
        prUrl: 'https://github.com/org/repo/pull/123',
        prNumber: 123,
      });

      expect(result).toEqual({
        status: 'started',
        sessionId: 'new-session-id',
      });

      expect(txContext.claudeSession.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          workspaceId: 'workspace-1',
          workflow: 'ci-fix',
          name: 'CI Fixing',
          status: SessionStatus.IDLE,
        }),
      });

      expect(sessionService.startClaudeSession).toHaveBeenCalledWith('new-session-id', {
        initialPrompt: expect.stringContaining('CI Failure Alert'),
      });
    });

    it('should inherit model from most recent workspace session', async () => {
      vi.mocked(workspaceAccessor.findById).mockResolvedValue(createMockWorkspace());

      const txContext = createMockTransactionContext();
      txContext.claudeSession.findFirst
        .mockResolvedValueOnce(null) // No existing CI fix session
        .mockResolvedValueOnce({ model: 'opus' }); // Most recent session uses opus
      txContext.claudeSession.findMany.mockResolvedValue([]);
      txContext.claudeSession.create.mockResolvedValue(createMockSession({ model: 'opus' }));

      mockTransaction(txContext);

      vi.mocked(configService.getMaxSessionsPerWorkspace).mockReturnValue(10);
      vi.mocked(sessionService.startClaudeSession).mockResolvedValue(undefined);

      await ciFixerService.triggerCIFix({
        workspaceId: 'workspace-1',
        prUrl: 'https://github.com/org/repo/pull/123',
        prNumber: 123,
      });

      expect(txContext.claudeSession.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          model: 'opus',
        }),
      });
    });

    it('should use sonnet as default model when no recent session exists', async () => {
      vi.mocked(workspaceAccessor.findById).mockResolvedValue(createMockWorkspace());

      const txContext = createMockTransactionContext();
      txContext.claudeSession.findFirst.mockResolvedValue(null); // No existing sessions
      txContext.claudeSession.findMany.mockResolvedValue([]);
      txContext.claudeSession.create.mockResolvedValue(createMockSession());

      mockTransaction(txContext);

      vi.mocked(configService.getMaxSessionsPerWorkspace).mockReturnValue(10);
      vi.mocked(sessionService.startClaudeSession).mockResolvedValue(undefined);

      await ciFixerService.triggerCIFix({
        workspaceId: 'workspace-1',
        prUrl: 'https://github.com/org/repo/pull/123',
        prNumber: 123,
      });

      expect(txContext.claudeSession.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          model: 'sonnet',
        }),
      });
    });
  });

  // ---------------------------------------------------------------------------
  // triggerCIFix - Session limit enforcement
  // ---------------------------------------------------------------------------

  describe('triggerCIFix - session limit enforcement', () => {
    it('should skip if workspace session limit is reached', async () => {
      vi.mocked(workspaceAccessor.findById).mockResolvedValue(createMockWorkspace());

      const txContext = createMockTransactionContext();
      txContext.claudeSession.findFirst.mockResolvedValue(null); // No existing CI fix session
      txContext.claudeSession.findMany.mockResolvedValue([
        { id: 'session-1' },
        { id: 'session-2' },
        { id: 'session-3' },
      ]); // 3 existing sessions

      mockTransaction(txContext);

      vi.mocked(configService.getMaxSessionsPerWorkspace).mockReturnValue(3); // Limit is 3

      const result = await ciFixerService.triggerCIFix({
        workspaceId: 'workspace-1',
        prUrl: 'https://github.com/org/repo/pull/123',
        prNumber: 123,
      });

      expect(result).toEqual({
        status: 'skipped',
        reason: 'Workspace session limit reached',
      });

      expect(txContext.claudeSession.create).not.toHaveBeenCalled();
    });

    it('should allow session creation when under limit', async () => {
      vi.mocked(workspaceAccessor.findById).mockResolvedValue(createMockWorkspace());

      const txContext = createMockTransactionContext();
      txContext.claudeSession.findFirst.mockResolvedValue(null);
      txContext.claudeSession.findMany.mockResolvedValue([{ id: 'session-1' }]); // 1 existing session
      txContext.claudeSession.create.mockResolvedValue(createMockSession({ id: 'new-session' }));

      mockTransaction(txContext);

      vi.mocked(configService.getMaxSessionsPerWorkspace).mockReturnValue(3); // Limit is 3
      vi.mocked(sessionService.startClaudeSession).mockResolvedValue(undefined);

      const result = await ciFixerService.triggerCIFix({
        workspaceId: 'workspace-1',
        prUrl: 'https://github.com/org/repo/pull/123',
        prNumber: 123,
      });

      expect(result.status).toBe('started');
      expect(txContext.claudeSession.create).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // triggerCIFix - Existing session handling
  // ---------------------------------------------------------------------------

  describe('triggerCIFix - existing session handling', () => {
    it('should return already_fixing when session is actively working', async () => {
      vi.mocked(workspaceAccessor.findById).mockResolvedValue(createMockWorkspace());

      const existingSession = createMockSession({
        id: 'existing-session',
        status: SessionStatus.RUNNING,
      });

      const txContext = createMockTransactionContext();
      txContext.claudeSession.findFirst.mockResolvedValue(existingSession);

      mockTransaction(txContext);

      vi.mocked(sessionService.isSessionWorking).mockReturnValue(true);

      const result = await ciFixerService.triggerCIFix({
        workspaceId: 'workspace-1',
        prUrl: 'https://github.com/org/repo/pull/123',
        prNumber: 123,
      });

      expect(result).toEqual({
        status: 'already_fixing',
        sessionId: 'existing-session',
      });

      expect(sessionService.startClaudeSession).not.toHaveBeenCalled();
    });

    it('should send message to running but idle session', async () => {
      vi.mocked(workspaceAccessor.findById).mockResolvedValue(createMockWorkspace());

      const existingSession = createMockSession({
        id: 'existing-session',
        status: SessionStatus.RUNNING,
      });

      const txContext = createMockTransactionContext();
      txContext.claudeSession.findFirst.mockResolvedValue(existingSession);

      mockTransaction(txContext);

      vi.mocked(sessionService.isSessionWorking).mockReturnValue(false); // Running but not actively working

      const mockClient = {
        sendMessage: vi.fn(),
      };
      // biome-ignore lint/suspicious/noExplicitAny: Mock client for testing
      vi.mocked(sessionService.getClient).mockReturnValue(mockClient as any);

      const result = await ciFixerService.triggerCIFix({
        workspaceId: 'workspace-1',
        prUrl: 'https://github.com/org/repo/pull/123',
        prNumber: 123,
      });

      expect(result).toEqual({
        status: 'already_fixing',
        sessionId: 'existing-session',
      });

      expect(mockClient.sendMessage).toHaveBeenCalledWith(expect.stringContaining('CI Failure'));
    });

    it('should restart IDLE session', async () => {
      vi.mocked(workspaceAccessor.findById).mockResolvedValue(createMockWorkspace());

      const existingSession = createMockSession({
        id: 'idle-session',
        status: SessionStatus.IDLE,
      });

      const txContext = createMockTransactionContext();
      txContext.claudeSession.findFirst.mockResolvedValue(existingSession);

      mockTransaction(txContext);

      vi.mocked(sessionService.isSessionWorking).mockReturnValue(false);
      vi.mocked(sessionService.startClaudeSession).mockResolvedValue(undefined);

      const result = await ciFixerService.triggerCIFix({
        workspaceId: 'workspace-1',
        prUrl: 'https://github.com/org/repo/pull/123',
        prNumber: 123,
      });

      expect(result).toEqual({
        status: 'started',
        sessionId: 'idle-session',
      });

      expect(sessionService.startClaudeSession).toHaveBeenCalledWith('idle-session', {
        initialPrompt: expect.stringContaining('CI Failure'),
      });
    });
  });

  // ---------------------------------------------------------------------------
  // triggerCIFix - Race condition prevention
  // ---------------------------------------------------------------------------

  describe('triggerCIFix - race condition prevention', () => {
    it('should return pending promise for concurrent triggers on same workspace', async () => {
      vi.mocked(workspaceAccessor.findById).mockResolvedValue(createMockWorkspace());

      const txContext = createMockTransactionContext();
      txContext.claudeSession.findFirst.mockResolvedValue(null);
      txContext.claudeSession.findMany.mockResolvedValue([]);
      txContext.claudeSession.create.mockResolvedValue(createMockSession({ id: 'new-session' }));

      // Simulate slow transaction
      mockSlowTransaction(txContext, 50);

      vi.mocked(configService.getMaxSessionsPerWorkspace).mockReturnValue(10);
      vi.mocked(sessionService.startClaudeSession).mockResolvedValue(undefined);

      // Trigger two concurrent calls
      const [result1, result2] = await Promise.all([
        ciFixerService.triggerCIFix({
          workspaceId: 'workspace-1',
          prUrl: 'https://github.com/org/repo/pull/123',
          prNumber: 123,
        }),
        ciFixerService.triggerCIFix({
          workspaceId: 'workspace-1',
          prUrl: 'https://github.com/org/repo/pull/123',
          prNumber: 123,
        }),
      ]);

      // Both should return the same result (the second one gets the pending promise)
      expect(result1).toEqual(result2);
      expect(result1.status).toBe('started');

      // Session should only be created once
      expect(txContext.claudeSession.create).toHaveBeenCalledTimes(1);
    });

    it('should allow concurrent triggers on different workspaces', async () => {
      vi.mocked(workspaceAccessor.findById).mockResolvedValue(createMockWorkspace());

      const txContext = createMockTransactionContext();
      txContext.claudeSession.findFirst.mockResolvedValue(null);
      txContext.claudeSession.findMany.mockResolvedValue([]);

      let createCallCount = 0;
      txContext.claudeSession.create.mockImplementation(() => {
        createCallCount++;
        return Promise.resolve(createMockSession({ id: `session-${createCallCount}` }));
      });

      mockTransaction(txContext);

      vi.mocked(configService.getMaxSessionsPerWorkspace).mockReturnValue(10);
      vi.mocked(sessionService.startClaudeSession).mockResolvedValue(undefined);

      // Trigger on two different workspaces
      const [result1, result2] = await Promise.all([
        ciFixerService.triggerCIFix({
          workspaceId: 'workspace-1',
          prUrl: 'https://github.com/org/repo/pull/123',
          prNumber: 123,
        }),
        ciFixerService.triggerCIFix({
          workspaceId: 'workspace-2',
          prUrl: 'https://github.com/org/repo/pull/456',
          prNumber: 456,
        }),
      ]);

      // Both should succeed independently
      expect(result1.status).toBe('started');
      expect(result2.status).toBe('started');

      // Sessions should be created for both
      expect(txContext.claudeSession.create).toHaveBeenCalledTimes(2);
    });
  });

  // ---------------------------------------------------------------------------
  // triggerCIFix - Initial prompt building
  // ---------------------------------------------------------------------------

  describe('triggerCIFix - initial prompt building', () => {
    it('should include PR number and URL in prompt', async () => {
      vi.mocked(workspaceAccessor.findById).mockResolvedValue(createMockWorkspace());

      const txContext = createMockTransactionContext();
      txContext.claudeSession.findFirst.mockResolvedValue(null);
      txContext.claudeSession.findMany.mockResolvedValue([]);
      txContext.claudeSession.create.mockResolvedValue(createMockSession());

      mockTransaction(txContext);

      vi.mocked(configService.getMaxSessionsPerWorkspace).mockReturnValue(10);
      vi.mocked(sessionService.startClaudeSession).mockResolvedValue(undefined);

      await ciFixerService.triggerCIFix({
        workspaceId: 'workspace-1',
        prUrl: 'https://github.com/org/repo/pull/123',
        prNumber: 123,
      });

      expect(sessionService.startClaudeSession).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          initialPrompt: expect.stringMatching(/PR #123/),
        })
      );

      expect(sessionService.startClaudeSession).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          initialPrompt: expect.stringContaining('https://github.com/org/repo/pull/123'),
        })
      );
    });

    it('should include failure details in prompt when provided', async () => {
      vi.mocked(workspaceAccessor.findById).mockResolvedValue(createMockWorkspace());

      const txContext = createMockTransactionContext();
      txContext.claudeSession.findFirst.mockResolvedValue(null);
      txContext.claudeSession.findMany.mockResolvedValue([]);
      txContext.claudeSession.create.mockResolvedValue(createMockSession());

      mockTransaction(txContext);

      vi.mocked(configService.getMaxSessionsPerWorkspace).mockReturnValue(10);
      vi.mocked(sessionService.startClaudeSession).mockResolvedValue(undefined);

      await ciFixerService.triggerCIFix({
        workspaceId: 'workspace-1',
        prUrl: 'https://github.com/org/repo/pull/123',
        prNumber: 123,
        failureDetails: {
          failedChecks: [
            { name: 'typecheck', conclusion: 'failure', detailsUrl: 'https://example.com/logs' },
            { name: 'lint', conclusion: 'failure' },
          ],
        },
      });

      const call = vi.mocked(sessionService.startClaudeSession).mock.calls[0];
      const prompt = call?.[1]?.initialPrompt ?? '';
      expect(call).toBeDefined();

      expect(prompt).toContain('typecheck');
      expect(prompt).toContain('lint');
      expect(prompt).toContain('https://example.com/logs');
    });
  });

  // ---------------------------------------------------------------------------
  // triggerCIFix - Error handling
  // ---------------------------------------------------------------------------

  describe('triggerCIFix - error handling', () => {
    it('should return error status when transaction fails', async () => {
      vi.mocked(workspaceAccessor.findById).mockResolvedValue(createMockWorkspace());
      vi.mocked(prisma.$transaction).mockRejectedValue(new Error('Database connection lost'));

      const result = await ciFixerService.triggerCIFix({
        workspaceId: 'workspace-1',
        prUrl: 'https://github.com/org/repo/pull/123',
        prNumber: 123,
      });

      expect(result).toEqual({
        status: 'error',
        error: 'Database connection lost',
      });
    });

    it('should return error status when session start fails', async () => {
      vi.mocked(workspaceAccessor.findById).mockResolvedValue(createMockWorkspace());

      const txContext = createMockTransactionContext();
      txContext.claudeSession.findFirst.mockResolvedValue(null);
      txContext.claudeSession.findMany.mockResolvedValue([]);
      txContext.claudeSession.create.mockResolvedValue(createMockSession());

      mockTransaction(txContext);

      vi.mocked(configService.getMaxSessionsPerWorkspace).mockReturnValue(10);
      vi.mocked(sessionService.startClaudeSession).mockRejectedValue(
        new Error('Failed to spawn Claude CLI')
      );

      const result = await ciFixerService.triggerCIFix({
        workspaceId: 'workspace-1',
        prUrl: 'https://github.com/org/repo/pull/123',
        prNumber: 123,
      });

      expect(result).toEqual({
        status: 'error',
        error: 'Failed to spawn Claude CLI',
      });
    });
  });

  // ---------------------------------------------------------------------------
  // isFixingInProgress
  // ---------------------------------------------------------------------------

  describe('isFixingInProgress', () => {
    it('should return false when no CI fix session exists', async () => {
      vi.mocked(claudeSessionAccessor.findByWorkspaceId).mockResolvedValue([]);

      const result = await ciFixerService.isFixingInProgress('workspace-1');

      expect(result).toBe(false);
    });

    it('should return false when CI fix session exists but is not working', async () => {
      vi.mocked(claudeSessionAccessor.findByWorkspaceId).mockResolvedValue([
        createMockSession({ id: 'ci-fix-session', workflow: 'ci-fix', status: SessionStatus.IDLE }),
      ]);

      vi.mocked(sessionService.isSessionWorking).mockReturnValue(false);

      const result = await ciFixerService.isFixingInProgress('workspace-1');

      expect(result).toBe(false);
    });

    it('should return true when CI fix session is actively working', async () => {
      vi.mocked(claudeSessionAccessor.findByWorkspaceId).mockResolvedValue([
        createMockSession({
          id: 'ci-fix-session',
          workflow: 'ci-fix',
          status: SessionStatus.RUNNING,
        }),
      ]);

      vi.mocked(sessionService.isSessionWorking).mockReturnValue(true);

      const result = await ciFixerService.isFixingInProgress('workspace-1');

      expect(result).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // getActiveCIFixSession
  // ---------------------------------------------------------------------------

  describe('getActiveCIFixSession', () => {
    it('should return null when no CI fix session exists', async () => {
      vi.mocked(claudeSessionAccessor.findByWorkspaceId).mockResolvedValue([]);

      const result = await ciFixerService.getActiveCIFixSession('workspace-1');

      expect(result).toBeNull();
    });

    it('should return null when only non-CI-fix sessions exist', async () => {
      vi.mocked(claudeSessionAccessor.findByWorkspaceId).mockResolvedValue([
        createMockSession({ workflow: 'default', status: SessionStatus.RUNNING }),
      ]);

      const result = await ciFixerService.getActiveCIFixSession('workspace-1');

      expect(result).toBeNull();
    });

    it('should return CI fix session when one exists', async () => {
      vi.mocked(claudeSessionAccessor.findByWorkspaceId).mockResolvedValue([
        createMockSession({
          id: 'ci-fix-session',
          workflow: 'ci-fix',
          status: SessionStatus.RUNNING,
        }),
      ]);

      const result = await ciFixerService.getActiveCIFixSession('workspace-1');

      expect(result).toEqual({
        id: 'ci-fix-session',
        status: SessionStatus.RUNNING,
      });
    });

    it('should ignore completed CI fix sessions', async () => {
      vi.mocked(claudeSessionAccessor.findByWorkspaceId).mockResolvedValue([
        createMockSession({
          id: 'old-session',
          workflow: 'ci-fix',
          status: SessionStatus.COMPLETED,
        }),
      ]);

      const result = await ciFixerService.getActiveCIFixSession('workspace-1');

      expect(result).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // notifyCIPassed
  // ---------------------------------------------------------------------------

  describe('notifyCIPassed', () => {
    it('should return false when no CI fix session exists', async () => {
      vi.mocked(claudeSessionAccessor.findByWorkspaceId).mockResolvedValue([]);

      const result = await ciFixerService.notifyCIPassed('workspace-1');

      expect(result).toBe(false);
    });

    it('should return false when session has no client', async () => {
      vi.mocked(claudeSessionAccessor.findByWorkspaceId).mockResolvedValue([
        createMockSession({
          id: 'ci-fix-session',
          workflow: 'ci-fix',
          status: SessionStatus.RUNNING,
        }),
      ]);

      vi.mocked(sessionService.getClient).mockReturnValue(undefined);

      const result = await ciFixerService.notifyCIPassed('workspace-1');

      expect(result).toBe(false);
    });

    it('should return false when client is not running', async () => {
      vi.mocked(claudeSessionAccessor.findByWorkspaceId).mockResolvedValue([
        createMockSession({
          id: 'ci-fix-session',
          workflow: 'ci-fix',
          status: SessionStatus.RUNNING,
        }),
      ]);

      const mockClient = {
        isRunning: vi.fn().mockReturnValue(false),
        sendMessage: vi.fn(),
      };
      // biome-ignore lint/suspicious/noExplicitAny: Mock client for testing
      vi.mocked(sessionService.getClient).mockReturnValue(mockClient as any);

      const result = await ciFixerService.notifyCIPassed('workspace-1');

      expect(result).toBe(false);
      expect(mockClient.sendMessage).not.toHaveBeenCalled();
    });

    it('should send CI passed message and return true when session is running', async () => {
      vi.mocked(claudeSessionAccessor.findByWorkspaceId).mockResolvedValue([
        createMockSession({
          id: 'ci-fix-session',
          workflow: 'ci-fix',
          status: SessionStatus.RUNNING,
        }),
      ]);

      const mockClient = {
        isRunning: vi.fn().mockReturnValue(true),
        sendMessage: vi.fn(),
      };
      // biome-ignore lint/suspicious/noExplicitAny: Mock client for testing
      vi.mocked(sessionService.getClient).mockReturnValue(mockClient as any);

      const result = await ciFixerService.notifyCIPassed('workspace-1');

      expect(result).toBe(true);
      expect(mockClient.sendMessage).toHaveBeenCalledWith(expect.stringContaining('CI Passed'));
    });
  });
});
