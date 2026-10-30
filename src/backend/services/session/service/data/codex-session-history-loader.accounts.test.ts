import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { codexSessionHistoryLoaderService } from './codex-session-history-loader.service';
const mocks = vi.hoisted(() => ({ history: vi.fn(), runtime: vi.fn(), preview: vi.fn() }));
vi.mock('@/backend/services/codex-accounts', () => ({
  codexAccountService: {
    getHistoryContext: mocks.history,
    getRuntimeContext: mocks.runtime,
    getPreviewRuntimeContext: mocks.preview,
  },
}));
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.clearAllMocks();
});
describe('offline Codex local history', () => {
  it('reads its exact saved profile while signed out, without native or model discovery', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ff-offline-history-'));
    dirs.push(home);
    const sessionsDir = join(home, 'sessions');
    const dateDir = join(sessionsDir, '2026', '02', '14');
    mkdirSync(dateDir, { recursive: true });
    writeFileSync(
      join(dateDir, 'rollout-offline-thread.jsonl'),
      [
        { type: 'session_meta', payload: { id: 'offline-thread', cwd: '/work' } },
        {
          type: 'event_msg',
          payload: { type: 'user_message', message: 'retained offline conversation' },
        },
      ]
        .map((value) => JSON.stringify(value))
        .join('\n')
    );
    mocks.history.mockResolvedValue({
      accountId: 'saved-offline',
      homeDir: home,
      sessionsDir,
      env: { CODEX_HOME: home },
    });
    mocks.runtime.mockRejectedValue(new Error('Not signed in'));
    mocks.preview.mockRejectedValue(new Error('Network unavailable'));
    await expect(
      codexSessionHistoryLoaderService.loadSessionHistory({
        codexAccountId: 'saved-offline',
        providerSessionId: 'offline-thread',
        workingDir: '/work',
      })
    ).resolves.toMatchObject({
      status: 'loaded',
      history: [{ content: 'retained offline conversation' }],
    });
    expect(mocks.history).toHaveBeenCalledExactlyOnceWith('saved-offline');
    expect(mocks.runtime).not.toHaveBeenCalled();
    expect(mocks.preview).not.toHaveBeenCalled();
  });
  it('does not consult the default profile if the saved local profile is missing', async () => {
    mocks.history.mockRejectedValue(new Error('Saved Codex profile is missing'));
    mocks.runtime.mockRejectedValue(new Error('Runtime must not be consulted'));
    await expect(
      codexSessionHistoryLoaderService.loadSessionHistory({
        codexAccountId: 'missing',
        providerSessionId: 'offline-thread',
        workingDir: '/work',
      })
    ).rejects.toThrow('Saved Codex profile is missing');
    expect(mocks.history).toHaveBeenCalledExactlyOnceWith('missing');
    expect(mocks.runtime).not.toHaveBeenCalled();
  });
});
