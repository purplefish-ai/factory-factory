import { describe, expect, it, vi } from 'vitest';
import { sessionRouter } from './session.trpc';
import type { Context, RequestTrustInfo } from './trpc';

function createCaller(requestTrust: RequestTrustInfo) {
  const snapshot = {
    provider: 'CODEX' as const,
    status: 'available' as const,
    windows: [],
    updatedAt: '2026-10-27T12:00:00.000Z',
  };
  const getUsage = vi.fn(async () => snapshot);
  const caller = sessionRouter.createCaller({
    requestTrust,
    appContext: {
      services: {
        configService: {
          getCorsConfig: () => ({ allowedOrigins: ['http://localhost:3000'] }),
        },
        providerUsageService: { getUsage },
      },
    },
  } as unknown as Context);
  return { caller, getUsage, snapshot };
}

describe('session provider usage trust boundary', () => {
  it.each([
    { isLocal: false, remoteAddress: '203.0.113.10' },
    { isLocal: true, remoteAddress: '127.0.0.1', origin: 'https://untrusted.example' },
  ])('rejects untrusted callers without starting a provider read: %j', async (trust) => {
    const { caller, getUsage } = createCaller(trust);
    await expect(caller.getProviderUsage({ provider: 'CODEX' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(getUsage).not.toHaveBeenCalled();
  });

  it('returns provider usage to a trusted local client', async () => {
    const { caller, getUsage, snapshot } = createCaller({
      isLocal: true,
      remoteAddress: '127.0.0.1',
      origin: 'http://localhost:3000',
    });
    await expect(caller.getProviderUsage({ provider: 'CODEX' })).resolves.toEqual(snapshot);
    expect(getUsage).toHaveBeenCalledExactlyOnceWith('CODEX');
  });
});
