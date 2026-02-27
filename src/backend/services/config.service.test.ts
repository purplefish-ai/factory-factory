import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configService } from './config.service';

const ORIGINAL_ENV = { ...process.env };

describe('configService environment accessors', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    configService.reload();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    configService.reload();
  });

  it('reads backend host from validated config', () => {
    process.env.BACKEND_HOST = '127.0.0.1';
    configService.reload();

    expect(configService.getBackendHost()).toBe('127.0.0.1');
  });

  it('returns undefined for blank backend host', () => {
    process.env.BACKEND_HOST = '   ';
    configService.reload();

    expect(configService.getBackendHost()).toBeUndefined();
  });

  it('defaults shell path when SHELL is not provided', () => {
    Reflect.deleteProperty(process.env, 'SHELL');
    configService.reload();

    expect(configService.getShellPath()).toBe('/bin/bash');
  });

  it('reads migrations path from validated config', () => {
    process.env.MIGRATIONS_PATH = '/tmp/migrations';
    configService.reload();

    expect(configService.getMigrationsPath()).toBe('/tmp/migrations');
  });

  it('builds profile/configuration values from environment aliases and toggles', () => {
    process.env.DEFAULT_MODEL = 'opus';
    process.env.DEFAULT_PERMISSIONS = 'strict';
    process.env.NODE_ENV = 'production';
    process.env.BACKEND_PORT = '4242';
    process.env.BACKEND_HOST = '0.0.0.0';
    process.env.BASE_DIR = '/tmp/factory-home';
    process.env.WORKTREE_BASE_DIR = '/tmp/factory-worktrees';
    process.env.REPOS_DIR = '/tmp/factory-repos';
    process.env.WS_LOGS_PATH = '/tmp/ws-logs';
    process.env.CLAUDE_CONFIG_DIR = '/tmp/claude-config';
    process.env.ACP_TRACE_LOGS_ENABLED = 'true';
    process.env.ACP_TRACE_LOGS_PATH = '/tmp/acp-trace';
    process.env.FF_RUN_SCRIPT_PROXY_ENABLED = '1';
    process.env.WS_LOGS_ENABLED = 'true';
    process.env.DEBUG_CHAT_WS = 'true';
    process.env.NOTIFICATION_SOUND_ENABLED = 'false';
    process.env.NOTIFICATION_PUSH_ENABLED = 'true';
    process.env.NOTIFICATION_SOUND_FILE = '/tmp/sound.wav';
    process.env.NOTIFICATION_QUIET_HOURS_START = '22';
    process.env.NOTIFICATION_QUIET_HOURS_END = '7';
    process.env.CORS_ALLOWED_ORIGINS = 'http://localhost:9999, https://example.com';
    process.env.BRANCH_RENAME_MESSAGE_THRESHOLD = '4';
    process.env.EVENT_COMPRESSION_ENABLED = 'false';
    process.env.WEB_CONCURRENCY = '3';
    process.env.npm_package_version = '9.9.9';
    process.env.DATABASE_PATH = '/tmp/custom.db';
    process.env.SERVICE_NAME = 'factory-test';
    process.env.LOG_LEVEL = 'debug';

    configService.reload();

    expect(configService.getEnvironment()).toBe('production');
    expect(configService.isProduction()).toBe(true);
    expect(configService.isDevelopment()).toBe(false);
    expect(configService.getBackendPort()).toBe(4242);
    expect(configService.getBackendHost()).toBe('0.0.0.0');
    expect(configService.getBaseDir()).toBe('/tmp/factory-home');
    expect(configService.getWorktreeBaseDir()).toBe('/tmp/factory-worktrees');
    expect(configService.getReposDir()).toBe('/tmp/factory-repos');
    expect(configService.getWsLogsPath()).toBe('/tmp/ws-logs');
    expect(configService.getClaudeConfigDir()).toBe('/tmp/claude-config');
    expect(configService.isAcpTraceLoggingEnabled()).toBe(true);
    expect(configService.getAcpTraceLogsPath()).toBe('/tmp/acp-trace');
    expect(configService.isRunScriptProxyEnabled()).toBe(true);
    expect(configService.isWsLogsEnabled()).toBe(true);
    expect(configService.getWebConcurrency()).toBe(3);
    expect(configService.getBranchRenameMessageThreshold()).toBe(4);
    expect(configService.getAppVersion()).toBe('9.9.9');
    expect(configService.getDatabasePath()).toBe('/tmp/custom.db');
    expect(configService.getDatabasePathFromEnv()).toBe('/tmp/custom.db');
    expect(configService.getDefaultSessionProfile()).toEqual({
      model: 'claude-opus-4-5-20251101',
      permissionMode: 'strict',
      maxTokens: 8192,
      temperature: 1,
    });

    expect(configService.getRateLimiterConfig()).toEqual(
      expect.objectContaining({
        claudeRequestsPerMinute: expect.any(Number),
        claudeRequestsPerHour: expect.any(Number),
        maxQueueSize: expect.any(Number),
        queueTimeoutMs: expect.any(Number),
      })
    );
    expect(configService.getNotificationConfig()).toEqual({
      soundEnabled: false,
      pushEnabled: true,
      soundFile: '/tmp/sound.wav',
      quietHoursStart: 22,
      quietHoursEnd: 7,
    });
    expect(configService.getCorsConfig()).toEqual({
      allowedOrigins: ['http://localhost:9999', 'https://example.com'],
    });
    expect(configService.getDebugConfig()).toEqual({ chatWebSocket: true });
    expect(configService.getCompressionConfig()).toEqual({ enabled: false });
    expect(configService.getFrontendStaticPath()).toBe(
      process.env.FRONTEND_STATIC_PATH?.trim() || undefined
    );
  });

  it('exposes additional getters and returns defensive copies', () => {
    process.env.NODE_ENV = 'development';
    process.env.SHELL = '/bin/zsh';
    process.env.FRONTEND_STATIC_PATH = '/tmp/frontend';
    process.env.MIGRATIONS_PATH = '/tmp/migrations';
    configService.reload();

    expect(configService.getShellPath()).toBe('/bin/zsh');
    expect(configService.getDebugLogDir()).toContain('debug');
    expect(configService.getAcpStartupTimeoutMs()).toBeGreaterThan(0);
    expect(configService.getMaxSessionsPerWorkspace()).toBeGreaterThan(0);
    expect(configService.getFrontendStaticPath()).toBe('/tmp/frontend');
    expect(configService.getMigrationsPath()).toBe('/tmp/migrations');
    expect(configService.getAvailableModels()).toEqual(
      expect.arrayContaining([
        { alias: 'sonnet', model: expect.any(String) },
        { alias: 'opus', model: expect.any(String) },
      ])
    );
    expect(configService.getAvailablePermissionModes()).toEqual(['strict', 'relaxed', 'yolo']);

    const childEnv = configService.getChildProcessEnv();
    childEnv.__TEST_CONFIG_COPY__ = 'mutated';
    expect(process.env.__TEST_CONFIG_COPY__).toBeUndefined();

    const systemConfig = configService.getSystemConfig();
    expect(systemConfig.backendPort).toBe(configService.getBackendPort());
    expect(systemConfig.logger.serviceName).toBeDefined();
  });
});
