import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockExportData = vi.hoisted(() => vi.fn());
const mockImportData = vi.hoisted(() => vi.fn());
const mockDecisionLogList = vi.hoisted(() => vi.fn());
const mockFindAgentSessionsByIds = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<Record<string, unknown>[]>>(async () => [])
);
const mockFindAgentSessionsWithPid = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<Record<string, unknown>[]>>(async () => [])
);
const mockFindTerminalSessionsWithPid = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<Record<string, unknown>[]>>(async () => [])
);
const mockFindWorkspacesByIdsWithProject = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<Record<string, unknown>[]>>(async () => [])
);
const mockMergeAgentSessions = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Record<string, unknown>[]>()
);
const mockBuildAgentProcesses = vi.hoisted(() =>
  vi.fn<
    (...args: unknown[]) => {
      agentProcesses: Record<string, unknown>[];
      orphanedSessionIds: string[];
    }
  >()
);
const mockReadFilteredLogEntriesPage = vi.hoisted(() => vi.fn());
const mockGetLogFilePath = vi.hoisted(() => vi.fn());
const mockStat = vi.hoisted(() => vi.fn());
const mockFsRead = vi.hoisted(() => vi.fn());
const mockFsClose = vi.hoisted(() => vi.fn());
const mockOpen = vi.hoisted(() => vi.fn());

vi.mock('node:fs/promises', () => ({
  stat: (...args: unknown[]) => mockStat(...args),
  open: (...args: unknown[]) => mockOpen(...args),
}));

vi.mock('@/backend/orchestration/data-backup.service', () => ({
  dataBackupService: {
    exportData: (...args: unknown[]) => mockExportData(...args),
    importData: (...args: unknown[]) => mockImportData(...args),
  },
}));

vi.mock('@/backend/orchestration/decision-log-query.service', () => ({
  decisionLogQueryService: {
    list: (...args: unknown[]) => mockDecisionLogList(...args),
  },
}));

vi.mock('@/backend/domains/session', () => ({
  sessionDataService: {
    findAgentSessionsByIds: mockFindAgentSessionsByIds,
    findAgentSessionsWithPid: mockFindAgentSessionsWithPid,
    findTerminalSessionsWithPid: mockFindTerminalSessionsWithPid,
  },
}));

vi.mock('@/backend/domains/workspace', () => ({
  workspaceDataService: {
    findByIdsWithProject: mockFindWorkspacesByIdsWithProject,
  },
}));

vi.mock('./admin-active-processes', () => ({
  mergeAgentSessions: (...args: unknown[]) => mockMergeAgentSessions(...args),
  buildAgentProcesses: (...args: unknown[]) => mockBuildAgentProcesses(...args),
}));

vi.mock('./log-file-reader', () => ({
  readFilteredLogEntriesPage: (...args: unknown[]) => mockReadFilteredLogEntriesPage(...args),
}));

vi.mock('@/backend/services/logger.service', () => ({
  getLogFilePath: (...args: unknown[]) => mockGetLogFilePath(...args),
}));

import { adminRouter } from './admin.trpc';

function createCaller() {
  const rateLimiter = {
    getApiUsageStats: vi.fn(() => ({
      requestsLastMinute: 2,
      requestsLastHour: 20,
      totalRequests: 200,
      queueDepth: 0,
      isRateLimited: false,
    })),
    updateConfig: vi.fn(),
    getConfig: vi.fn(() => ({
      claudeRequestsPerMinute: 10,
      claudeRequestsPerHour: 100,
    })),
    getUsageByAgent: vi.fn(
      () =>
        new Map([
          ['agent-1', 42],
          ['agent-2', 7],
        ])
    ),
    getUsageByTopLevelTask: vi.fn(() => new Map([['task-1', 11]])),
    resetUsageStats: vi.fn(),
  };

  const sessionService = {
    isSessionRunning: vi.fn(() => true),
    stopSession: vi.fn(async () => undefined),
  };

  const cliHealthService = {
    checkHealth: vi.fn((forceRefresh: boolean) => ({
      forceRefresh,
      allHealthy: true,
    })),
    upgradeProviderCLI: vi.fn(async (provider: 'CLAUDE' | 'CODEX' | 'OPENCODE') => ({
      provider,
      packageName:
        provider === 'CLAUDE'
          ? '@anthropic-ai/claude-code'
          : provider === 'CODEX'
            ? '@openai/codex'
            : 'opencode-ai',
      command: `npm install -g ${
        provider === 'CLAUDE'
          ? '@anthropic-ai/claude-code'
          : provider === 'CODEX'
            ? '@openai/codex'
            : 'opencode-ai'
      }`,
      output: 'ok',
      health: {
        claude: { isInstalled: true },
        codex: { isInstalled: true, isAuthenticated: true },
        opencode: { isInstalled: true, isAuthenticated: true },
        github: { isInstalled: true, isAuthenticated: true },
        allHealthy: true,
      },
    })),
  };

  const terminalService = {
    getAllTerminals: vi.fn<() => Record<string, unknown>[]>(() => []),
  };

  const acpRuntimeManager = {
    getAllActiveProcesses: vi.fn<() => Record<string, unknown>[]>(() => []),
  };

  const ratchetService = {
    checkAllWorkspaces: vi.fn(async () => ({
      checked: 3,
      stateChanges: 1,
      actionsTriggered: 2,
    })),
  };

  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const caller = adminRouter.createCaller({
    appContext: {
      services: {
        configService: {
          getSystemConfig: () => ({
            nodeEnv: 'test',
          }),
          getAppVersion: () => '0.3.6',
        },
        serverInstanceService: {
          getPort: () => 3111,
        },
        rateLimiter,
        cliHealthService,
        acpRuntimeManager,
        terminalService,
        ratchetService,
        sessionService,
        createLogger: () => logger,
      },
    },
  } as never);

  return {
    caller,
    rateLimiter,
    sessionService,
    cliHealthService,
    acpRuntimeManager,
    terminalService,
    logger,
  };
}

describe('adminRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockMergeAgentSessions.mockReturnValue([]);
    mockBuildAgentProcesses.mockReturnValue({
      agentProcesses: [],
      orphanedSessionIds: [],
    });

    mockGetLogFilePath.mockReturnValue('/tmp/server.log');
    mockReadFilteredLogEntriesPage.mockResolvedValue({
      entries: [],
      total: 0,
      totalIsExact: true,
      hasMore: false,
    });

    mockStat.mockResolvedValue({ size: 0 });
    mockFsRead.mockResolvedValue({ bytesRead: 0 });
    mockFsClose.mockResolvedValue(undefined);
    mockOpen.mockResolvedValue({
      read: (...args: unknown[]) => mockFsRead(...args),
      close: (...args: unknown[]) => mockFsClose(...args),
    });
  });

  it('returns server info and system stats', async () => {
    const { caller } = createCaller();
    await expect(caller.getServerInfo()).resolves.toEqual({
      backendPort: 3111,
      environment: 'test',
      version: '0.3.6',
    });
    await expect(caller.getSystemStats()).resolves.toEqual({
      apiUsage: expect.objectContaining({ totalRequests: 200 }),
      environment: 'test',
    });
  });

  it('updates and reports rate limiting data', async () => {
    const { caller, rateLimiter } = createCaller();

    await expect(
      caller.updateRateLimits({
        claudeRequestsPerMinute: 33,
        claudeRequestsPerHour: 333,
      })
    ).resolves.toEqual({
      success: true,
      newConfig: {
        claudeRequestsPerMinute: 10,
        claudeRequestsPerHour: 100,
      },
    });
    expect(rateLimiter.updateConfig).toHaveBeenCalledWith({
      claudeRequestsPerMinute: 33,
      claudeRequestsPerHour: 333,
    });

    await expect(caller.getApiUsageByAgent()).resolves.toEqual({
      byAgent: {
        'agent-1': 42,
        'agent-2': 7,
      },
      byTopLevelTask: {
        'task-1': 11,
      },
    });

    await expect(caller.resetApiUsageStats()).resolves.toEqual({
      success: true,
      message: 'API usage statistics reset',
    });
    expect(rateLimiter.resetUsageStats).toHaveBeenCalledTimes(1);
  });

  it('handles health checks, decision-log export, data import/export, and session stop', async () => {
    const { caller, sessionService } = createCaller();
    const logDate = new Date('2026-02-10T00:00:00.000Z');
    mockDecisionLogList.mockResolvedValue([
      {
        id: 'log-1',
        agentId: 'agent-1',
        decision: 'ship',
        reasoning: 'looks good',
        context: { source: 'test' },
        timestamp: logDate,
      },
    ]);
    mockExportData.mockResolvedValue({ ok: true });
    mockImportData.mockResolvedValue({ imported: 3, skipped: 0 });

    await expect(caller.checkCLIHealth()).resolves.toEqual({
      forceRefresh: false,
      allHealthy: true,
    });
    await expect(caller.checkCLIHealth({ forceRefresh: true })).resolves.toEqual({
      forceRefresh: true,
      allHealthy: true,
    });
    await expect(caller.upgradeProviderCLI({ provider: 'CODEX' })).resolves.toEqual(
      expect.objectContaining({
        provider: 'CODEX',
        packageName: '@openai/codex',
        message: 'Codex CLI upgraded successfully.',
      })
    );

    await expect(
      caller.exportDecisionLogs({
        since: '2026-02-01T00:00:00.000Z',
        limit: 100,
      })
    ).resolves.toEqual({
      count: 1,
      logs: [
        {
          id: 'log-1',
          agentId: 'agent-1',
          decision: 'ship',
          reasoning: 'looks good',
          context: { source: 'test' },
          timestamp: logDate.toISOString(),
        },
      ],
    });

    await expect(caller.exportDecisionLogs({})).resolves.toEqual({
      count: 1,
      logs: [
        {
          id: 'log-1',
          agentId: 'agent-1',
          decision: 'ship',
          reasoning: 'looks good',
          context: { source: 'test' },
          timestamp: logDate.toISOString(),
        },
      ],
    });

    await expect(caller.exportData()).resolves.toEqual({ ok: true });
    expect(mockExportData).toHaveBeenCalledWith('0.3.6');

    await expect(
      caller.importData({
        meta: {
          exportedAt: '2026-02-10T10:00:00.000Z',
          version: '0.3.6',
          schemaVersion: 4,
        },
        data: {
          projects: [],
          workspaces: [],
          agentSessions: [],
          terminalSessions: [],
          userSettings: null,
        },
      })
    ).resolves.toEqual({
      success: true,
      results: { imported: 3, skipped: 0 },
    });

    await expect(caller.triggerRatchetCheck()).resolves.toEqual({
      success: true,
      checked: 3,
      stateChanges: 1,
      actionsTriggered: 2,
    });

    await expect(caller.stopSession({ sessionId: 's-1' })).resolves.toEqual({ wasRunning: true });
    expect(sessionService.isSessionRunning).toHaveBeenCalledWith('s-1');
    expect(sessionService.stopSession).toHaveBeenCalledWith('s-1');
  });

  it('wraps provider upgrade failures as tRPC errors', async () => {
    const { caller, cliHealthService } = createCaller();
    cliHealthService.upgradeProviderCLI.mockRejectedValueOnce(new Error('upgrade failed'));

    await expect(caller.upgradeProviderCLI({ provider: 'CLAUDE' })).rejects.toMatchObject({
      message: 'upgrade failed',
    });
  });

  it('returns active process summaries and logs orphaned ACP sessions', async () => {
    const { caller, acpRuntimeManager, terminalService, logger } = createCaller();
    const createdAt = new Date('2026-02-10T10:00:00.000Z');
    acpRuntimeManager.getAllActiveProcesses.mockReturnValue([
      { sessionId: 's-1', pid: 101, status: 'running' },
      { sessionId: 's-orphan', pid: 999, status: 'running' },
    ]);
    terminalService.getAllTerminals.mockReturnValue([
      {
        id: 'terminal-1',
        workspaceId: 'w-terminal',
        pid: 300,
        cols: 120,
        rows: 40,
        createdAt,
        resourceUsage: { cpu: 0.2, memory: 1_048_576 },
      },
    ]);

    mockFindAgentSessionsByIds.mockResolvedValue([{ id: 'db-s-1', workspaceId: 'w-agent' }]);
    mockFindAgentSessionsWithPid.mockResolvedValue([{ id: 'db-s-stale', workspaceId: 'w-agent' }]);
    mockFindTerminalSessionsWithPid.mockResolvedValue([
      { id: 'terminal-session-1', workspaceId: 'w-terminal', pid: 300 },
    ]);
    mockFindWorkspacesByIdsWithProject.mockResolvedValue([
      {
        id: 'w-agent',
        name: 'Agent Workspace',
        branchName: 'feature/agent',
        project: { slug: 'agent-project' },
      },
      {
        id: 'w-terminal',
        name: 'Terminal Workspace',
        branchName: 'feature/terminal',
        project: { slug: 'terminal-project' },
      },
    ]);
    mockMergeAgentSessions.mockReturnValue([{ id: 'db-s-1', workspaceId: 'w-agent' }]);
    mockBuildAgentProcesses.mockReturnValue({
      agentProcesses: [{ sessionId: 's-1' }],
      orphanedSessionIds: ['s-orphan'],
    });

    await expect(caller.getActiveProcesses()).resolves.toEqual({
      agent: [{ sessionId: 's-1' }],
      terminal: [
        {
          terminalId: 'terminal-1',
          workspaceId: 'w-terminal',
          workspaceName: 'Terminal Workspace',
          workspaceBranch: 'feature/terminal',
          projectSlug: 'terminal-project',
          pid: 300,
          cols: 120,
          rows: 40,
          createdAt,
          dbSessionId: 'terminal-session-1',
          cpuPercent: 0.2,
          memoryBytes: 1_048_576,
        },
      ],
      summary: {
        totalAgent: 1,
        totalTerminal: 1,
        total: 2,
      },
    });

    expect(mockFindWorkspacesByIdsWithProject).toHaveBeenCalledWith(
      expect.arrayContaining(['w-agent', 'w-terminal'])
    );
    expect(logger.warn).toHaveBeenCalledWith('Found in-memory ACP process without DB record', {
      sessionId: 's-orphan',
      pid: 999,
      status: 'running',
    });
  });

  it('returns parsed logs and falls back when reading fails', async () => {
    const { caller } = createCaller();
    const since = '2026-01-01T00:00:00.000Z';
    const until = '2026-02-01T00:00:00.000Z';
    mockReadFilteredLogEntriesPage.mockResolvedValueOnce({
      entries: [{ timestamp: '2026-01-15T00:00:00.000Z', level: 'error', message: 'boom' }],
      total: 1,
      totalIsExact: true,
      hasMore: false,
    });

    await expect(
      caller.getLogs({
        search: 'Boom',
        level: 'error',
        since,
        until,
        limit: 20,
        offset: 2,
      })
    ).resolves.toEqual({
      entries: [{ timestamp: '2026-01-15T00:00:00.000Z', level: 'error', message: 'boom' }],
      total: 1,
      totalIsExact: true,
      hasMore: false,
      filePath: '/tmp/server.log',
    });

    expect(mockReadFilteredLogEntriesPage).toHaveBeenCalledWith(
      '/tmp/server.log',
      {
        level: 'error',
        search: 'boom',
        sinceMs: new Date(since).getTime(),
        untilMs: new Date(until).getTime(),
      },
      {
        limit: 20,
        offset: 2,
      }
    );

    mockReadFilteredLogEntriesPage.mockRejectedValueOnce(new Error('missing log file'));
    await expect(caller.getLogs({})).resolves.toEqual({
      entries: [],
      total: 0,
      totalIsExact: false,
      hasMore: false,
      filePath: '/tmp/server.log',
    });
  });

  it('downloads truncated log content and returns empty content on read errors', async () => {
    const { caller } = createCaller();
    const maxBytes = 10 * 1024 * 1024;

    mockStat.mockResolvedValueOnce({ size: maxBytes + 5 });
    mockFsRead.mockImplementationOnce((buffer: Buffer) => {
      buffer.fill('x');
      buffer.write('drop-this-line\nkept-content', 0, 'utf-8');
      return { bytesRead: buffer.length };
    });
    await expect(caller.downloadLogFile()).resolves.toContain('kept-content');
    expect(mockFsClose).toHaveBeenCalledTimes(1);

    mockStat.mockRejectedValueOnce(new Error('missing'));
    await expect(caller.downloadLogFile()).resolves.toBe('');
  });
});
