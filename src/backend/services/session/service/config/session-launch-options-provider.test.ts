import { afterEach, describe, expect, it, vi } from 'vitest';
import { deferred } from '@/test-utils/deferred';
import { fetchAccountSessionLaunchOptions } from './session-launch-options-provider';
const mocks = vi.hoisted(() => ({ preview: vi.fn(), probe: vi.fn() }));
vi.mock('@/backend/services/codex-accounts', () => ({
  codexAccountService: { getPreviewRuntimeContext: mocks.preview },
}));
vi.mock('@/backend/services/session/service/acp/session-launch-options-probe', () => ({
  fetchSessionLaunchOptionsFromAcp: mocks.probe,
}));
afterEach(() => vi.clearAllMocks());
describe('account-aware launch probe boundary', () => {
  it('resolves an explicit account before passing only its environment to ACP', async () => {
    const env = { CODEX_HOME: '/managed/profile' };
    mocks.preview.mockResolvedValue({ accountId: 'saved', env });
    mocks.probe.mockReturnValue({
      result: Promise.resolve({ provider: 'CODEX', model: 'model' }),
      drained: Promise.resolve(),
    });
    await fetchAccountSessionLaunchOptions({
      provider: 'CODEX',
      model: 'model',
      codexAccountId: 'saved',
    });
    expect(mocks.preview).toHaveBeenCalledExactlyOnceWith({ accountId: 'saved', model: 'model' });
    expect(mocks.probe).toHaveBeenCalledExactlyOnceWith({ provider: 'CODEX', model: 'model', env });
  });
  it('does not spawn if shutdown interrupts account resolution', async () => {
    const context = deferred<{ accountId: string; env: NodeJS.ProcessEnv }>();
    mocks.preview.mockReturnValue(context.promise);
    const cancellation = new AbortController();
    const reading = fetchAccountSessionLaunchOptions({ provider: 'CODEX' }, cancellation.signal);
    cancellation.abort(new Error('stopped'));
    context.resolve({ accountId: 'saved', env: {} });
    await expect(reading).rejects.toThrow('stopped');
    expect(mocks.probe).not.toHaveBeenCalled();
  });

  it('keeps Claude discovery independent of Codex accounts', async () => {
    mocks.probe.mockReturnValue({
      result: Promise.resolve({ provider: 'CLAUDE', model: 'sonnet' }),
      drained: Promise.resolve(),
    });
    await fetchAccountSessionLaunchOptions({ provider: 'CLAUDE', model: 'sonnet' });
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.probe).toHaveBeenCalledExactlyOnceWith({ provider: 'CLAUDE', model: 'sonnet' });
  });
});
