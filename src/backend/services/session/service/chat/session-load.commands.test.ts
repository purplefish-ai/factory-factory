import { describe, expect, it, vi } from 'vitest';
import { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { EMPTY_CHAT_BAR_CAPABILITIES } from '@/shared/chat-capabilities';
import type { SessionRuntimeState } from '@/shared/session-runtime';
import { SessionLoadService } from './session-load.service';

const stopped: SessionRuntimeState = {
  phase: 'idle',
  processState: 'stopped',
  activity: 'IDLE',
  updatedAt: new Date().toISOString(),
};
const alive: SessionRuntimeState = { ...stopped, processState: 'alive' };

describe('session-local Codex commands on reload', () => {
  it('replays live A skills across navigation without clearing them or leaking them into stopped B', async () => {
    const domain = new SessionDomainService();
    const emitDelta = vi.spyOn(domain, 'emitDelta');
    const getCachedCommands = vi
      .fn()
      .mockResolvedValue([{ name: '/foreign-global', description: 'Must not be used' }]);
    const runtimes = new Map([
      ['a', alive],
      ['b', stopped],
    ]);
    const service = new SessionLoadService({
      findSession: async (id) => ({
        provider: 'CODEX',
        codexAccountId: `account-${id}`,
        providerSessionId: id,
        providerMetadata: null,
        status: 'IDLE',
        workspace: { status: 'READY', worktreePath: '/work' },
      }),
      hydrateProviderHistory: async () => undefined,
      hydrateLifecycleEvents: async () => undefined,
      getRuntimeSnapshot: (id) => runtimes.get(id) ?? stopped,
      domain,
      config: {
        getSessionConfigProjection: async () => ({
          currentProjection: () => ({
            capabilities: EMPTY_CHAT_BAR_CAPABILITIES,
            configOptions: [],
          }),
        }),
      },
      getCachedCommands,
      tryDispatchNextMessage: async () => undefined,
    });
    const commands = [{ name: '/account-a-skill', description: 'Only A' }];
    domain.emitDelta('a', { type: 'slash_commands', slashCommands: commands });
    async function load(id: string) {
      const prepared = await service.prepareLoad({ sessionId: id });
      if (prepared.status !== 'ready') {
        throw new Error('Expected ready session');
      }
      const replay = service.captureReplay(prepared);
      emitDelta.mockClear();
      await service.completeLoad(prepared);
      return replay.replayEvents.filter((event) => event.type === 'slash_commands');
    }
    expect(await load('a')).toEqual([{ type: 'slash_commands', slashCommands: commands }]);
    expect(emitDelta).not.toHaveBeenCalledWith('a', { type: 'slash_commands', slashCommands: [] });
    expect(await load('b')).toEqual([]);
    expect(emitDelta).toHaveBeenCalledWith('b', { type: 'slash_commands', slashCommands: [] });
    expect(await load('a')).toEqual([{ type: 'slash_commands', slashCommands: commands }]);
    expect(getCachedCommands).not.toHaveBeenCalled();
    runtimes.set('a', stopped);
    domain.setRuntimeSnapshot('a', stopped);
    expect(await load('a')).toEqual([]);
    runtimes.set('a', alive);
    expect(await load('a')).toEqual([{ type: 'slash_commands', slashCommands: [] }]);
    domain.clearAllSessions();
  });
});
