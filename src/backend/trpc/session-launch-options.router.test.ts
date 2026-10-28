import { describe, expect, it, vi } from 'vitest';
import { createFakeApplicationGraph } from '@/test-utils/application-graph';
import { sessionRouter } from './session.trpc';
import type { RequestTrustInfo } from './trpc';
function fixture(requestTrust?: RequestTrustInfo) {
  const graph = createFakeApplicationGraph('launch-options-router');
  const getLaunchOptions = vi.fn().mockResolvedValue({
    provider: 'CODEX',
    model: 'native-model',
    reasoning: { options: [] },
    planMode: { supported: false, selected: false },
  });
  const caller = sessionRouter.createCaller({
    requestTrust,
    appContext: {
      ...graph,
      services: {
        ...graph.services,
        configService: Object.assign({}, graph.services.configService, {
          getCorsConfig: () => ({ allowedOrigins: ['http://localhost:3000'] }),
        }),
        sessionConfigService: Object.assign({}, graph.services.sessionConfigService, {
          getLaunchOptions,
        }),
      },
    },
  });
  return { caller, getLaunchOptions };
}
describe('native launch options transport', () => {
  it.each([
    { isLocal: false, remoteAddress: '203.0.113.10' },
    { isLocal: true, remoteAddress: '127.0.0.1', origin: 'https://untrusted.example' },
  ])('rejects untrusted requests before native execution: %j', async (requestTrust) => {
    const f = fixture(requestTrust);
    await expect(f.caller.getLaunchOptions({ provider: 'CODEX' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(f.getLaunchOptions).not.toHaveBeenCalled();
  });
  it.each(['CLAUDE', 'CODEX'] as const)(
    'allows selected-model discovery for a trusted local %s request',
    async (provider) => {
      const f = fixture({
        isLocal: true,
        remoteAddress: '127.0.0.1',
        origin: 'http://localhost:3000',
      });
      await f.caller.getLaunchOptions({ provider, model: 'native-model' });
      expect(f.getLaunchOptions).toHaveBeenCalledExactlyOnceWith({
        provider,
        model: 'native-model',
      });
    }
  );
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
