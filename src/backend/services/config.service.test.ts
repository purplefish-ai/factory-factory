import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { configService } from './config.service';

const packageInfo = z
  .object({ version: z.string() })
  .parse(JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')));

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

  it.each([undefined, '', 'abc', '123garbage', '0', '-1', '1048575', '268435457', '2097152.5'])(
    'defaults invalid or absent websocket frame budget %s',
    (value) => {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, 'WEBSOCKET_MAX_FRAME_BYTES');
      } else {
        process.env.WEBSOCKET_MAX_FRAME_BYTES = value;
      }
      configService.reload();
      expect(configService.getWebSocketConfig()).toEqual({ maxFrameBytes: 33_554_432 });
    }
  );
  it.each(['1048576', '67108864', '268435456'])(
    'reads bounded websocket frame budget %s',
    (value) => {
      process.env.WEBSOCKET_MAX_FRAME_BYTES = value;
      configService.reload();
      expect(configService.getWebSocketConfig()).toEqual({ maxFrameBytes: Number(value) });
    }
  );

  it('reads backend host from validated config', () => {
    process.env.BACKEND_HOST = '127.0.0.1';
    configService.reload();

    expect(configService.getBackendHost()).toBe('127.0.0.1');
  });

  it('reads the ff tailscale origin used for port sharing', () => {
    process.env.FF_TAILSCALE_ORIGIN = 'https://mac.tail123.ts.net';
    process.env.FF_TAILSCALE_HTTPS_PORT = '443';
    configService.reload();
    expect(configService.getTailscaleConfig()).toEqual({
      origin: 'https://mac.tail123.ts.net',
      hostname: 'mac.tail123.ts.net',
      httpsPort: 443,
    });

    process.env.FF_TAILSCALE_ORIGIN = 'https://mac.tail123.ts.net:8443';
    delete process.env.FF_TAILSCALE_HTTPS_PORT;
    configService.reload();
    expect(configService.getTailscaleConfig()?.httpsPort).toBe(8443);
  });

  it('canonicalizes equivalent spellings of the ff tailscale origin', () => {
    delete process.env.FF_TAILSCALE_HTTPS_PORT;
    process.env.FF_TAILSCALE_ORIGIN = 'https://Mac.Tail123.TS.net:443/';
    configService.reload();
    expect(configService.getTailscaleConfig()).toEqual({
      origin: 'https://mac.tail123.ts.net',
      hostname: 'mac.tail123.ts.net',
      httpsPort: 443,
    });
  });

  it.each([
    undefined,
    '',
    'http://mac.tail123.ts.net',
    'https://mac.tail123.ts.net/path',
    'https://mac.tail123.ts.net/?x=1',
    'https://user@mac.tail123.ts.net',
    'nope',
  ])('disables port sharing for the Tailscale origin %j', (origin) => {
    if (origin === undefined) {
      delete process.env.FF_TAILSCALE_ORIGIN;
    } else {
      process.env.FF_TAILSCALE_ORIGIN = origin;
    }
    configService.reload();
    expect(configService.getTailscaleConfig()).toBeNull();
  });

  it('emits the startup port line when a launcher or the run-script proxy asks', () => {
    delete process.env.FF_EMIT_BACKEND_PORT;
    delete process.env.FF_RUN_SCRIPT_PROXY_ENABLED;
    configService.reload();
    expect(configService.shouldEmitBackendPort()).toBe(false);

    process.env.FF_EMIT_BACKEND_PORT = '1';
    configService.reload();
    expect(configService.shouldEmitBackendPort()).toBe(true);

    delete process.env.FF_EMIT_BACKEND_PORT;
    process.env.FF_RUN_SCRIPT_PROXY_ENABLED = '1';
    configService.reload();
    expect(configService.shouldEmitBackendPort()).toBe(true);
  });

  it('returns undefined for blank backend host', () => {
    process.env.BACKEND_HOST = '   ';
    configService.reload();

    expect(configService.getBackendHost()).toBeUndefined();
  });

  it('reads PR discovery limits from validated config', () => {
    process.env.PR_DISCOVERY_CANDIDATE_LIMIT = '25';
    process.env.PR_DISCOVERY_REPOSITORY_LIMIT = '4';
    configService.reload();

    expect(configService.getPRDiscoveryLimits()).toEqual({
      candidateLimit: 25,
      repositoryLimit: 4,
    });
  });

  it('defaults PR discovery limits when environment variables are absent', () => {
    Reflect.deleteProperty(process.env, 'PR_DISCOVERY_CANDIDATE_LIMIT');
    Reflect.deleteProperty(process.env, 'PR_DISCOVERY_REPOSITORY_LIMIT');
    configService.reload();

    expect(configService.getPRDiscoveryLimits()).toEqual({
      candidateLimit: 100,
      repositoryLimit: 10,
    });
  });

  it('rejects non-positive PR discovery limits', () => {
    process.env.PR_DISCOVERY_CANDIDATE_LIMIT = '0';
    process.env.PR_DISCOVERY_REPOSITORY_LIMIT = '-1';
    configService.reload();

    expect(configService.getPRDiscoveryLimits()).toEqual({
      candidateLimit: 100,
      repositoryLimit: 10,
    });
  });

  it('defaults ACP startup and session creation timeouts independently', () => {
    Reflect.deleteProperty(process.env, 'ACP_STARTUP_TIMEOUT_MS');
    Reflect.deleteProperty(process.env, 'ACP_SESSION_CREATION_TIMEOUT_MS');
    configService.reload();

    expect(configService.getAcpStartupTimeoutMs()).toBe(30_000);
    expect(configService.getAcpSessionCreationTimeoutMs()).toBe(120_000);
  });

  it('reads the ACP session creation timeout and rejects invalid values', () => {
    process.env.ACP_STARTUP_TIMEOUT_MS = '5000';
    process.env.ACP_SESSION_CREATION_TIMEOUT_MS = '90000';
    configService.reload();

    expect(configService.getAcpStartupTimeoutMs()).toBe(5000);
    expect(configService.getAcpSessionCreationTimeoutMs()).toBe(90_000);

    process.env.ACP_SESSION_CREATION_TIMEOUT_MS = '0';
    configService.reload();

    expect(configService.getAcpSessionCreationTimeoutMs()).toBe(120_000);
  });

  it('returns defensive copies of PR discovery limits', () => {
    process.env.PR_DISCOVERY_CANDIDATE_LIMIT = '25';
    process.env.PR_DISCOVERY_REPOSITORY_LIMIT = '4';
    configService.reload();

    const limits = configService.getPRDiscoveryLimits();
    limits.candidateLimit = 1;
    limits.repositoryLimit = 1;

    expect(configService.getPRDiscoveryLimits()).toEqual({
      candidateLimit: 25,
      repositoryLimit: 4,
    });
  });

  it('defaults shell path when SHELL is not provided', () => {
    Reflect.deleteProperty(process.env, 'SHELL');
    configService.reload();

    expect(configService.getShellPath()).toBe('/bin/bash');
  });

  it('keeps event classifier settings separate from execution and metadata settings', () => {
    process.env.WORKSPACE_METADATA_CLAUDE_MODEL = 'metadata-claude';
    configService.reload();
    const classifier = configService.getAgentEventClassifierConfig();
    expect(classifier).toEqual({
      claudeModel: 'haiku',
      codexModel: 'gpt-6-luna',
      timeoutMs: 30_000,
      maxConcurrent: 2,
    });
    expect(Object.isFrozen(configService.getAgentEventClassifierConfig())).toBe(false);
  });

  it('returns a defensive copy of workspace metadata configuration', () => {
    process.env.WORKSPACE_METADATA_ENABLED = 'true';
    process.env.WORKSPACE_METADATA_CODEX_MODEL = 'metadata-codex';
    process.env.WORKSPACE_METADATA_CLAUDE_MODEL = 'metadata-claude';
    configService.reload();

    const metadata = configService.getWorkspaceMetadataConfig();
    metadata.enabled = false;
    metadata.codexModel = 'changed';
    metadata.claudeModel = 'changed';

    expect(configService.getWorkspaceMetadataConfig()).toEqual({
      enabled: true,
      codexModel: 'metadata-codex',
      claudeModel: 'metadata-claude',
    });
  });

  it('reads migrations path from validated config', () => {
    process.env.MIGRATIONS_PATH = '/tmp/migrations';
    configService.reload();

    expect(configService.getMigrationsPath()).toBe('/tmp/migrations');
  });

  it('reads the Node exec path that Electron main passes to its backend', () => {
    process.env.FF_NODE_EXEC_PATH =
      '/Applications/Factory Factory.app/Contents/MacOS/Factory Factory';
    configService.reload();

    expect(configService.getNodeExecPath()).toBe(
      '/Applications/Factory Factory.app/Contents/MacOS/Factory Factory'
    );
  });

  it('defaults the Node exec path to the current runtime', () => {
    process.env.FF_NODE_EXEC_PATH = '  ';
    configService.reload();
    expect(configService.getNodeExecPath()).toBe(process.execPath);

    Reflect.deleteProperty(process.env, 'FF_NODE_EXEC_PATH');
    configService.reload();
    expect(configService.getNodeExecPath()).toBe(process.execPath);
  });

  it('defaults disableCorsChecks to false when DISABLE_CORS_CHECKS is absent', () => {
    Reflect.deleteProperty(process.env, 'DISABLE_CORS_CHECKS');
    configService.reload();

    expect(configService.getCorsConfig().disableCorsChecks).toBe(false);
  });

  it.each([
    [undefined, true],
    ['localhost', true],
    ['127.0.0.1', true],
    ['::1', true],
    ['0.0.0.0', false],
    ['::', false],
    ['192.168.1.20', false],
    ['factory.lan', false],
  ])('allows the own loopback origin only when BACKEND_HOST=%s is loopback', (host, allowed) => {
    Reflect.deleteProperty(process.env, 'CORS_ALLOWED_ORIGINS');
    if (host === undefined) {
      Reflect.deleteProperty(process.env, 'BACKEND_HOST');
    } else {
      process.env.BACKEND_HOST = host;
    }
    configService.reload();

    expect(configService.getCorsConfig().allowOwnLoopbackOrigin).toBe(allowed);
  });

  it.each([
    ['http://localhost:5173', true],
    ['https://mac.tail123.ts.net', false],
    ['https://ff.example.com,http://localhost:3001', false],
  ])('derives the own-origin allowance from CORS_ALLOWED_ORIGINS=%s', (origins, allowed) => {
    Reflect.deleteProperty(process.env, 'BACKEND_HOST');
    process.env.CORS_ALLOWED_ORIGINS = origins;
    configService.reload();

    expect(configService.getCorsConfig().allowOwnLoopbackOrigin).toBe(allowed);
  });

  it('expands BASE_DIR before dependent config paths', () => {
    const bracedBaseDir = '$' + '{BASE_DIR}';
    process.env.USER = 'testuser';
    process.env.BASE_DIR = '/Users/$USER/factory-factory';
    process.env.WORKTREE_BASE_DIR = '$BASE_DIR/worktrees';
    process.env.REPOS_DIR = `${bracedBaseDir}/repos`;
    process.env.DATABASE_PATH = '$BASE_DIR/data.db';
    process.env.MIGRATIONS_PATH = `${bracedBaseDir}/migrations`;
    configService.reload();

    expect(configService.getWorktreeBaseDir()).toBe('/Users/testuser/factory-factory/worktrees');
    expect(configService.getReposDir()).toBe('/Users/testuser/factory-factory/repos');
    expect(configService.getDatabasePath()).toBe('/Users/testuser/factory-factory/data.db');
    expect(configService.getMigrationsPath()).toBe('/Users/testuser/factory-factory/migrations');
    expect(process.env.BASE_DIR).toBe('/Users/$USER/factory-factory');
    expect(process.env.WORKTREE_BASE_DIR).toBe('$BASE_DIR/worktrees');
  });

  it('builds profile/configuration values from environment aliases and toggles', () => {
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
    process.env.CORS_ALLOWED_ORIGINS = 'http://localhost:9999, https://example.com';
    process.env.TRUSTED_LOCAL_CIDRS = '172.17.0.1/32, 172.18.0.0/16';
    process.env.TRUST_PROXY_HEADERS = 'true';
    process.env.DISABLE_CORS_CHECKS = 'true';
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
    // A launcher's npm_package_version must not override the installed app's version.
    expect(configService.getAppVersion()).toBe(packageInfo.version);
    expect(configService.getDatabasePath()).toBe('/tmp/custom.db');
    expect(configService.getDatabasePathFromEnv()).toBe('/tmp/custom.db');

    expect(configService.getRateLimiterConfig()).toEqual(
      expect.objectContaining({
        claudeRequestsPerMinute: expect.any(Number),
        claudeRequestsPerHour: expect.any(Number),
        maxQueueSize: expect.any(Number),
        queueTimeoutMs: expect.any(Number),
      })
    );
    expect(configService.getCorsConfig()).toEqual({
      allowedOrigins: ['http://localhost:9999', 'https://example.com'],
      trustedLocalCidrs: ['172.17.0.1/32', '172.18.0.0/16'],
      trustProxyHeaders: true,
      disableCorsChecks: true,
      // BACKEND_HOST=0.0.0.0 is not loopback.
      allowOwnLoopbackOrigin: false,
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

    const childEnv = configService.getChildProcessEnv();
    childEnv.__TEST_CONFIG_COPY__ = 'mutated';
    expect(process.env.__TEST_CONFIG_COPY__).toBeUndefined();

    const systemConfig = configService.getSystemConfig();
    expect(systemConfig.backendPort).toBe(configService.getBackendPort());
    expect(systemConfig.logger.serviceName).toBeDefined();
  });
});

describe('Codex native profile configuration', () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    configService.reload();
  });
  it('uses the configured home and preserves the legacy history override', () => {
    process.env.CODEX_HOME = '/configured/codex';
    process.env.CODEX_SESSIONS_DIR = '/configured/history';
    configService.reload();
    expect(configService.getCodexHome()).toBe('/configured/codex');
    expect(configService.getCodexSessionsDir()).toBe('/configured/history');
  });
  it('derives history from the configured native home', () => {
    process.env.CODEX_HOME = '/configured/codex';
    delete process.env.CODEX_SESSIONS_DIR;
    configService.reload();
    expect(configService.getCodexSessionsDir()).toBe(join('/configured/codex', 'sessions'));
  });
  it.each(['   ', ' /configured/codex '])(
    'keeps native Codex child paths consistent with validated configuration: %j',
    (home) => {
      process.env.CODEX_HOME = home;
      process.env.CODEX_SESSIONS_DIR = '   ';
      configService.reload();
      const child = configService.getChildProcessEnv();
      expect(child.CODEX_HOME).toBe(configService.getCodexHome());
      expect(child.CODEX_SESSIONS_DIR).toBe(configService.getCodexSessionsDir());
    }
  );
});

describe('terminal agent run context retention policy', () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    configService.reload();
  });
  it.each([undefined, '', '0', '-1', '1.5', '1day', '1e2', 'invalid', 'Infinity', '365001'])(
    'retains indefinitely for missing/invalid opt-in %s',
    (value) => {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, 'AGENT_RUN_CONTEXT_RETENTION_DAYS');
      } else {
        process.env.AGENT_RUN_CONTEXT_RETENTION_DAYS = value;
      }
      configService.reload();
      expect(configService.getAgentRuntimeLimits().runContextRetentionMs).toBeNull();
    }
  );
  it('accepts explicit positive days through configService', () => {
    process.env.AGENT_RUN_CONTEXT_RETENTION_DAYS = '45';
    configService.reload();
    expect(configService.getAgentRuntimeLimits().runContextRetentionMs).toBe(45 * 86_400_000);
  });
  it('holds event runs for child work at most 24 hours', () => {
    expect(configService.getAgentRuntimeLimits().childHoldDeadlineMs).toBe(24 * 60 * 60 * 1000);
  });
});

describe('Slack event intake gate', () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    configService.reload();
  });
  it.each([undefined, '', 'false', '1', 'yes', 'TRUE '])('stays off for %j', (value) => {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, 'AGENT_SLACK_INTAKE_ENABLED');
    } else {
      process.env.AGENT_SLACK_INTAKE_ENABLED = value;
    }
    configService.reload();
    expect(configService.getAgentRuntimeLimits().slackIntakeEnabled).toBe(false);
  });
  it('turns on only for an explicit true', () => {
    process.env.AGENT_SLACK_INTAKE_ENABLED = 'true';
    configService.reload();
    expect(configService.getAgentRuntimeLimits().slackIntakeEnabled).toBe(true);
  });
});

describe('release check configuration', () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    configService.reload();
  });
  it('checks the public npm registry by default', () => {
    Reflect.deleteProperty(process.env, 'FF_UPDATE_CHECKS_ENABLED');
    Reflect.deleteProperty(process.env, 'FF_NPM_REGISTRY_URL');
    configService.reload();
    expect(configService.getReleaseCheckConfig()).toEqual({
      enabled: true,
      registryUrl: 'https://registry.npmjs.org',
    });
  });
  it.each([
    ['false', false],
    ['true', true],
    ['0', true],
    ['', true],
  ])('reads FF_UPDATE_CHECKS_ENABLED=%j as %s', (value, enabled) => {
    process.env.FF_UPDATE_CHECKS_ENABLED = value;
    configService.reload();
    expect(configService.getReleaseCheckConfig().enabled).toBe(enabled);
  });
  it('reads an HTTP registry URL without its trailing slash', () => {
    process.env.FF_NPM_REGISTRY_URL = 'http://127.0.0.1:4873/';
    configService.reload();
    expect(configService.getReleaseCheckConfig().registryUrl).toBe('http://127.0.0.1:4873');
  });
  it.each(['not a url', 'file:///etc/passwd', 'ftp://registry.example'])(
    'keeps the public registry for %j',
    (value) => {
      process.env.FF_NPM_REGISTRY_URL = value;
      configService.reload();
      expect(configService.getReleaseCheckConfig().registryUrl).toBe('https://registry.npmjs.org');
    }
  );
});
