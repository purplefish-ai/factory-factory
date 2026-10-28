import { describe, expect, it, vi } from 'vitest';
import { createFakeApplicationGraph } from '@/test-utils/application-graph';
import { sessionRouter } from './session.trpc';
function fixture() {
  const graph = createFakeApplicationGraph('launch-options-router');
  const getLaunchOptions = vi.fn().mockResolvedValue({
    provider: 'CODEX',
    model: 'native-model',
    reasoning: { options: [] },
    planMode: { supported: false, selected: false },
  });
  const caller = sessionRouter.createCaller({
    appContext: {
      ...graph,
      services: {
        ...graph.services,
        sessionConfigService: Object.assign({}, graph.services.sessionConfigService, {
          getLaunchOptions,
        }),
      },
    },
  });
  return { caller, getLaunchOptions };
}
describe('native launch options transport', () => {
  it('uses the injected selected-model discovery capability without guessing unsupported options', async () => {
    const f = fixture();
    expect(await f.caller.getLaunchOptions({ provider: 'CODEX', model: ' native-model ' })).toEqual(
      {
        provider: 'CODEX',
        model: 'native-model',
        reasoning: { options: [] },
        planMode: { supported: false, selected: false },
      }
    );
    expect(f.getLaunchOptions).toHaveBeenCalledExactlyOnceWith({
      provider: 'CODEX',
      model: 'native-model',
    });
  });
  it('rejects a blank model before native discovery', async () => {
    const f = fixture();
    await expect(
      f.caller.getLaunchOptions({ provider: 'CODEX', model: ' ' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(f.getLaunchOptions).not.toHaveBeenCalled();
  });
  it('propagates provider discovery failure for a truthful Retry state', async () => {
    const f = fixture();
    f.getLaunchOptions.mockRejectedValue(new Error('Native discovery unavailable'));
    await expect(
      f.caller.getLaunchOptions({ provider: 'CLAUDE', model: 'sonnet' })
    ).rejects.toThrow('Native discovery unavailable');
  });
});
