import { vi } from 'vitest';
import type { Application } from '@/backend/app-context';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';

export type TestHarnessOptions = {
  backendHost?: string;
  frontendStaticPath?: string | null;
  isRunScriptProxyEnabled?: boolean;
};

export function createTestHarness(options: TestHarnessOptions = {}) {
  const logger = {
    debug: vi.fn<(...args: unknown[]) => void>(),
    error: vi.fn<(...args: unknown[]) => void>(),
    info: vi.fn<(...args: unknown[]) => void>(),
    warn: vi.fn<(...args: unknown[]) => void>(),
  };

  const services = {
    configService: {
      getBackendPort: () => 0,
      getBackendHost: () => options.backendHost,
      getEnvironment: () => 'test',
      getFrontendStaticPath: () => options.frontendStaticPath ?? null,
      isDevelopment: () => false,
      isRunScriptProxyEnabled: () => options.isRunScriptProxyEnabled ?? false,
      shouldEmitBackendPort: () => options.isRunScriptProxyEnabled ?? false,
      getTailscaleConfig: () => null,
      getCorsConfig: () => ({ allowedOrigins: ['http://localhost:3000'] }),
      getAppVersion: () => 'test-version',
      getDatabasePath: () => '/tmp/test.db',
      getDatabasePathFromEnv: () => undefined,
    },
    createLogger: () => logger,
    findAvailablePort: vi.fn(async (startPort: number) => startPort),
    ratchetService: {
      start: vi.fn<(...args: unknown[]) => void>(),
      stop: vi.fn(async () => undefined),
    },
    rateLimiter: {
      start: vi.fn<(...args: unknown[]) => void>(),
      stop: vi.fn(async () => undefined),
      getApiUsageStats: vi.fn(() => ({
        requestsLastMinute: 0,
        isRateLimited: false,
      })),
    },
    schedulerService: {
      start: vi.fn<(...args: unknown[]) => void>(),
      stop: vi.fn(async () => undefined),
    },
    periodicTaskService: {
      start: vi.fn<(...args: unknown[]) => void>(),
      stop: vi.fn(async () => undefined),
    },
    agentRuntime: {
      start: vi.fn<(...args: unknown[]) => void>(),
      stop: vi.fn(async () => undefined),
    },
    reconciliationService: {
      cleanupOrphans: vi.fn(async () => undefined),
      recoverStaleProvisioningWorkspaces: vi.fn(async () => undefined),
      startNewWorkspaceInitialization: vi.fn<(...args: unknown[]) => void>(),
      startPeriodicCleanup: vi.fn<(...args: unknown[]) => void>(),
      stopPeriodicCleanup: vi.fn(async () => undefined),
    },
    runScriptStateMachine: {
      recoverStaleStates: vi.fn(async () => undefined),
    },
    runScriptService: {
      cleanup: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    },
    portShareService: {
      cleanup: vi.fn<() => Promise<void>>(() => Promise.resolve()),
      stopStaleShares: vi.fn<() => Promise<void>>(() => Promise.resolve()),
      isAvailable: () => false,
      getShareOrigin: () => null,
      ensure: vi.fn<(port: number) => Promise<string>>(),
    },
    acpTraceLogger: {
      cleanup: vi.fn<(...args: unknown[]) => void>(),
      cleanupOldLogs: vi.fn<(...args: unknown[]) => void>(),
    },
    sessionFileLogger: {
      cleanup: vi.fn<(...args: unknown[]) => void>(),
      cleanupOldLogs: vi.fn<(...args: unknown[]) => void>(),
    },
    cleanupOldLogFiles: vi.fn(async () => 0),
    sessionConfigService: {
      stopLaunchOptions: vi.fn(async () => undefined),
      warmLaunchOptions: vi.fn(async () => undefined),
    },
    sessionLifecycleService: {
      recoverStaleRunningSessions: vi.fn(async () => 0),
      stopAllClients: vi.fn(async () => undefined),
    },
    sessionDispatchService: {
      shutdown: vi.fn(async () => undefined),
    },
    codexAccountService: {
      shutdown: vi.fn(async () => undefined),
    },
    terminalService: {
      cleanup: vi.fn<(...args: unknown[]) => void>(),
    },
    workspaceGitStateService: {
      stop: vi.fn<(...args: unknown[]) => void>(),
    },
  };

  const lifecycle = {
    database: {
      $disconnect: vi.fn(async () => undefined),
    },
    jobs: {
      stopAll: vi.fn(async () => undefined),
    },
    interceptors: {
      register: vi.fn<(...args: unknown[]) => void>(),
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    },
    wireDomainBridges: vi.fn<(...args: unknown[]) => void>(),
    eventCollector: {
      configure: vi.fn<(...args: unknown[]) => void>(),
      stop: vi.fn<(...args: unknown[]) => void>(),
    },
    snapshotReconciliation: {
      configure: vi.fn<(...args: unknown[]) => void>(),
      start: vi.fn<(...args: unknown[]) => void>(),
      stop: vi.fn(async () => undefined),
    },
    recoverStaleArchivingWorkspaces: vi.fn(async () => ({ archived: [], failed: [] })),
  };

  const application = unsafeCoerce<Application>({ services, lifecycle, config: {} });

  return {
    application,
    lifecycle,
    logger,
    services,
  };
}

export function createTestApplication(options: TestHarnessOptions = {}): Application {
  return createTestHarness(options).application;
}
