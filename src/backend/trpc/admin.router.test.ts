import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockExportData = vi.hoisted(() => vi.fn());
const mockImportData = vi.hoisted(() => vi.fn());
const mockDecisionLogList = vi.hoisted(() => vi.fn());
const mockGetAllActiveProcesses = vi.hoisted(() => vi.fn(() => []));

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
  acpRuntimeManager: {
    getAllActiveProcesses: () => mockGetAllActiveProcesses(),
  },
  sessionDataService: {
    findAgentSessionsByIds: vi.fn(async () => []),
    findAgentSessionsWithPid: vi.fn(async () => []),
    findTerminalSessionsWithPid: vi.fn(async () => []),
  },
}));

vi.mock('@/backend/domains/workspace', () => ({
  workspaceDataService: {
    findByIdsWithProject: vi.fn(async () => []),
  },
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

  const caller = adminRouter.createCaller({
    appContext: {
      services: {
        configService: {
          getSystemConfig: () => ({
            nodeEnv: 'test',
            features: { authentication: false, metrics: true, errorTracking: false },
          }),
          getAppVersion: () => '0.3.6',
        },
        serverInstanceService: {
          getPort: () => 3111,
        },
        rateLimiter,
        cliHealthService: {
          checkHealth: vi.fn((forceRefresh: boolean) => ({
            forceRefresh,
            allHealthy: true,
          })),
          upgradeProviderCLI: vi.fn(async (provider: 'CLAUDE' | 'CODEX') => ({
            provider,
            packageName: provider === 'CLAUDE' ? '@anthropic-ai/claude-code' : '@openai/codex',
            command: `npm install -g ${
              provider === 'CLAUDE' ? '@anthropic-ai/claude-code' : '@openai/codex'
            }`,
            output: 'ok',
            health: {
              claude: { isInstalled: true },
              codex: { isInstalled: true, isAuthenticated: true },
              github: { isInstalled: true, isAuthenticated: true },
              allHealthy: true,
            },
          })),
        },
        terminalService: {
          getAllTerminals: vi.fn(() => []),
        },
        ratchetService: {
          checkAllWorkspaces: vi.fn(async () => ({
            checked: 3,
            stateChanges: 1,
            actionsTriggered: 2,
          })),
        },
        sessionService,
        createLogger: () => ({
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        }),
      },
    },
  } as never);

  return {
    caller,
    rateLimiter,
    sessionService,
  };
}

describe('adminRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      features: { authentication: false, metrics: true, errorTracking: false },
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
});
