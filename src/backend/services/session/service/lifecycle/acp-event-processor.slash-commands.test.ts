import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  setCachedCommands: vi.fn(),
}));

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  getCurrentProcessEnv: () => ({ ...process.env }),
}));

vi.mock('@/backend/services/session/service/acp', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    AcpEventTranslator: class MockAcpEventTranslator {
      translateSessionUpdate = vi.fn().mockReturnValue([]);
    },
  };
});

vi.mock('@/backend/interceptors/registry', () => ({
  interceptorRegistry: {
    notifyToolStart: vi.fn(),
    notifyToolComplete: vi.fn(),
  },
}));

vi.mock('@/backend/services/session/service/logging/acp-trace-logger.service', () => ({
  acpTraceLogger: { log: vi.fn() },
}));

vi.mock('@/backend/services/session/service/logging/session-file-logger.service', () => ({
  sessionFileLogger: { log: vi.fn() },
}));

vi.mock('@/backend/services/session/service/store/slash-command-cache.service', () => ({
  slashCommandCacheService: {
    setCachedCommands: mocks.setCachedCommands,
  },
}));

import type { AcpEventProcessorDependencies } from './acp-event-processor';
import { AcpEventProcessor } from './acp-event-processor';

function makeDeps(
  overrides: Partial<AcpEventProcessorDependencies> = {}
): AcpEventProcessorDependencies {
  return {
    runtimeManager: {
      getClient: vi.fn(),
      isSessionWorking: vi.fn().mockReturnValue(true),
    } as unknown as AcpEventProcessorDependencies['runtimeManager'],
    sessionDomainService: {
      emitDelta: vi.fn(),
      appendClaudeEvent: vi.fn().mockReturnValue(1),
      upsertClaudeEvent: vi.fn(),
      allocateOrder: vi.fn().mockReturnValue(1),
    } as unknown as AcpEventProcessorDependencies['sessionDomainService'],
    sessionPermissionService: {
      createPermissionBridge: vi.fn().mockReturnValue({ cancelAll: vi.fn() }),
      handlePermissionRequest: vi.fn(),
    } as unknown as AcpEventProcessorDependencies['sessionPermissionService'],
    sessionConfigService: {
      applyConfigOptionsUpdateDelta: vi.fn(),
    } as unknown as AcpEventProcessorDependencies['sessionConfigService'],
    onToolCallTimeout: vi.fn(),
    ...overrides,
  };
}

describe('AcpEventProcessor slash command caching', () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.setCachedCommands.mockResolvedValue(undefined);
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('excludes workspace-local Claude commands from provider cache writes', () => {
    const worktreePath = mkdtempSync(join(tmpdir(), 'ff-acp-slash-commands-'));
    tempDirs.push(worktreePath);
    const commandsDir = join(worktreePath, '.claude', 'commands');
    mkdirSync(commandsDir, { recursive: true });
    writeFileSync(
      join(commandsDir, 'workspace-only.md'),
      '---\ndescription: Workspace only\n---\n'
    );

    const deps = makeDeps();
    const processor = new AcpEventProcessor(deps);
    processor.registerSessionContext('session-1', {
      workspaceId: 'workspace-1',
      workingDir: worktreePath,
      provider: 'CLAUDE',
    });

    processor.handleAcpDelta('session-1', {
      type: 'slash_commands',
      slashCommands: [
        { name: '/global-only', description: 'Global only' },
        { name: '/project:workspace-only', description: 'Workspace only' },
      ],
    });

    expect(mocks.setCachedCommands).toHaveBeenCalledWith('CLAUDE', [
      { name: '/global-only', description: 'Global only' },
    ]);
    expect(deps.sessionDomainService.emitDelta).toHaveBeenCalledWith('session-1', {
      type: 'slash_commands',
      slashCommands: [
        { name: '/global-only', description: 'Global only' },
        { name: '/project:workspace-only', description: 'Workspace only' },
      ],
    });
  });
});
