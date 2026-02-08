import { SessionStatus } from '@prisma-gen/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    startClaudeSession: vi.fn(),
    getClient: vi.fn(),
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

import { prisma } from '../db';
import { claudeSessionAccessor } from '../resource_accessors/claude-session.accessor';
import { workspaceAccessor } from '../resource_accessors/workspace.accessor';
import { configService } from './config.service';
import { fixerSessionService } from './fixer-session.service';
import { sessionService } from './session.service';

type MockTransactionContext = {
  workspace: {
    findUnique: ReturnType<typeof vi.fn>;
  };
  claudeSession: {
    findFirst: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
};

function createTxContext(): MockTransactionContext {
  return {
    workspace: {
      findUnique: vi.fn().mockResolvedValue({ worktreePath: '/tmp/w' }),
    },
    claudeSession: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
    },
  };
}

function mockTransaction(txContext: MockTransactionContext) {
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  vi.mocked(prisma.$transaction).mockImplementation((callback: (tx: any) => Promise<unknown>) =>
    Promise.resolve(callback(txContext))
  );
}

describe('FixerSessionService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

    const tx = createTxContext();
    tx.claudeSession.findFirst.mockResolvedValue({
      id: 's1',
      status: SessionStatus.RUNNING,
    });
    mockTransaction(tx);

    vi.mocked(sessionService.isSessionWorking).mockReturnValue(true);

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

    const tx = createTxContext();
    tx.claudeSession.findFirst.mockResolvedValue({
      id: 's1',
      status: SessionStatus.RUNNING,
    });
    mockTransaction(tx);

    vi.mocked(sessionService.isSessionWorking).mockReturnValue(false);
    const client = { sendMessage: vi.fn() };
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    vi.mocked(sessionService.getClient).mockReturnValue(client as any);

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
    expect(client.sendMessage).toHaveBeenCalledWith('prompt');
  });

  it('creates and starts a new session', async () => {
    vi.mocked(workspaceAccessor.findById).mockResolvedValue({ worktreePath: '/tmp/w' } as never);

    const tx = createTxContext();
    tx.claudeSession.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ model: 'opus' });
    tx.claudeSession.findMany.mockResolvedValue([]);
    tx.claudeSession.create.mockResolvedValue({ id: 's-new' });
    mockTransaction(tx);

    vi.mocked(configService.getMaxSessionsPerWorkspace).mockReturnValue(5);
    vi.mocked(sessionService.startClaudeSession).mockResolvedValue(undefined);

    const result = await fixerSessionService.acquireAndDispatch({
      workspaceId: 'w1',
      workflow: 'ci-fix',
      sessionName: 'CI Fixing',
      runningIdleAction: 'send_message',
      buildPrompt: () => 'prompt',
    });

    expect(result).toEqual({ status: 'started', sessionId: 's-new' });
    expect(sessionService.startClaudeSession).toHaveBeenCalledWith('s-new', {
      initialPrompt: 'prompt',
    });
  });

  it('deduplicates concurrent acquisition by workspace/workflow', async () => {
    vi.mocked(workspaceAccessor.findById).mockResolvedValue({ worktreePath: '/tmp/w' } as never);

    const tx = createTxContext();
    tx.claudeSession.findFirst.mockResolvedValue(null);
    tx.claudeSession.findMany.mockResolvedValue([]);
    tx.claudeSession.create.mockResolvedValue({ id: 's-new' });

    vi.mocked(prisma.$transaction).mockImplementation(
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      async (callback: (tx: any) => Promise<unknown>) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return callback(tx);
      }
    );

    vi.mocked(configService.getMaxSessionsPerWorkspace).mockReturnValue(5);
    vi.mocked(sessionService.startClaudeSession).mockResolvedValue(undefined);

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
    expect(tx.claudeSession.create).toHaveBeenCalledTimes(1);
  });

  it('returns latest active session for workflow', async () => {
    vi.mocked(claudeSessionAccessor.findByWorkspaceId).mockResolvedValue([
      {
        id: 'old',
        workflow: 'ci-fix',
        status: SessionStatus.RUNNING,
        createdAt: new Date('2025-01-01T00:00:00Z'),
      },
      {
        id: 'new',
        workflow: 'ci-fix',
        status: SessionStatus.IDLE,
        createdAt: new Date('2025-01-02T00:00:00Z'),
      },
    ] as never);

    const result = await fixerSessionService.getActiveSession('w1', 'ci-fix');
    expect(result).toEqual({ id: 'new', status: SessionStatus.IDLE });
  });
});
