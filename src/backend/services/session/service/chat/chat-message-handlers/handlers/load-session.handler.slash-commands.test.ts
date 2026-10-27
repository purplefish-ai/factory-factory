import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  getCachedCommands: vi.fn(),
  emitDelta: vi.fn(),
}));
vi.mock('@/backend/services/session/resources/agent-session.accessor', () => ({
  agentSessionAccessor: { findById: mocks.findById },
}));
vi.mock('@/backend/services/session/service/lifecycle/session-provider-history-hydrator', () => ({
  hydrateProviderHistoryIfNeeded: vi.fn(),
}));
vi.mock('@/backend/services/session/service/lifecycle/session-core-services', () => ({
  sessionLifecycleService: { getRuntimeSnapshot: () => ({ processState: 'alive' }) },
  sessionLifecycleEventService: { hydrate: vi.fn() },
  sessionConfigService: {
    getChatBarCapabilities: vi.fn(),
    getSessionConfigOptionsWithFallback: () => [],
  },
}));
vi.mock('@/backend/services/session/service/session-domain.service', () => ({
  sessionDomainService: {
    subscribe: vi.fn(),
    emitDelta: mocks.emitDelta,
    consumeInitialMessage: () => null,
  },
}));
vi.mock('@/backend/services/session/service/store/slash-command-cache.service', () => ({
  slashCommandCacheService: { getCachedCommands: mocks.getCachedCommands },
}));
import { createLoadSessionHandler } from './load-session.handler';

it('merges scoped cached commands against complete workspace disk namespaces', async () => {
  const worktreePath = mkdtempSync(join(tmpdir(), 'ff-scoped-cache-merge-'));
  try {
    const commandsPath = join(worktreePath, '.claude', 'commands');
    mkdirSync(join(commandsPath, 'user'), { recursive: true });
    writeFileSync(join(commandsPath, 'deploy.md'), '---\ndescription: Workspace deploy\n---\n');
    writeFileSync(
      join(commandsPath, 'user', 'deploy.md'),
      '---\ndescription: Namespaced deploy\n---\n'
    );
    mocks.findById.mockResolvedValue({
      provider: 'CLAUDE',
      status: 'IDLE',
      workspace: { status: 'READY', worktreePath },
    });
    mocks.getCachedCommands.mockResolvedValue([
      { name: '/user:deploy', description: 'Global root deploy' },
      { name: '/user:user:deploy', description: 'Global namespaced deploy' },
      { name: '/user:inspect', description: 'Global inspect' },
      { name: '/project:foreign', description: 'Foreign project command' },
    ]);
    const handler = createLoadSessionHandler({
      tryDispatchNextMessage: vi.fn(),
      setManualDispatchResume: vi.fn(),
    });
    await handler({
      ws: { send: vi.fn() } as never,
      sessionId: 'session-1',
      workingDir: worktreePath,
      message: { type: 'load_session' },
    });
    const update = mocks.emitDelta.mock.calls.find(
      ([, event]) => event.type === 'slash_commands'
    )?.[1];
    expect(
      update?.slashCommands.sort((a: { name: string }, b: { name: string }) =>
        a.name.localeCompare(b.name)
      )
    ).toEqual([
      { name: '/user:inspect', description: 'Global inspect' },
      { name: 'deploy', description: 'Workspace deploy' },
      { name: 'user:deploy', description: 'Namespaced deploy' },
    ]);
  } finally {
    rmSync(worktreePath, { recursive: true, force: true });
  }
});
