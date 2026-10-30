import { describe, expect, it, vi } from 'vitest';
import { codexAccountsRouter } from './codex-accounts.trpc';
import type { Context, RequestTrustInfo } from './trpc';

const usage = {
  provider: 'CODEX',
  status: 'available',
  windows: [],
  updatedAt: '2026-10-29T20:00:00.000Z',
};
const account = {
  id: 'account-b',
  label: 'Secondary',
  kind: 'MANAGED',
  enabled: true,
  authenticated: true,
  email: 'second@example.test',
  planType: 'pro',
  usage,
};
function setup(requestTrust?: RequestTrustInfo) {
  const service = {
    getAccounts: vi.fn(async () => [
      { ...account, env: { SECRET: 'never-send' }, homeDir: '/private/profile' },
    ]),
    createAccount: vi.fn(async () => account),
    updateAccount: vi.fn(async () => account),
    startLogin: vi.fn(async () => ({
      accountId: account.id,
      status: 'pending',
      authorizationUrl: 'https://auth.openai.com/oauth/authorize?state=test',
    })),
    getLoginStatus: vi.fn(async () => ({ accountId: account.id, status: 'completed' })),
    cancelLogin: vi.fn(async () => undefined),
    getUsage: vi.fn(async () => usage),
  };
  const caller = codexAccountsRouter.createCaller({
    requestTrust,
    appContext: {
      services: {
        codexAccountService: service,
        configService: {
          getCorsConfig: () => ({
            allowedOrigins: ['http://localhost:3000'],
            trustedLocalCidrs: [],
            disableCorsChecks: false,
          }),
        },
      },
    },
  } as unknown as Context);
  return { caller, service };
}

describe('Codex account transport', () => {
  it.each([
    { isLocal: false, remoteAddress: '203.0.113.2' },
    { isLocal: true, remoteAddress: '127.0.0.1', origin: 'https://untrusted.example' },
  ])('rejects account management and reads from untrusted callers: %j', async (trust) => {
    const { caller, service } = setup(trust);
    const calls = [
      () => caller.list(),
      () => caller.create({ label: 'Secondary' }),
      () => caller.update({ id: account.id, enabled: false }),
      () => caller.startLogin({ id: account.id }),
      () => caller.loginStatus({ id: account.id }),
      () => caller.cancelLogin({ id: account.id }),
      () => caller.getUsage({ id: account.id }),
    ];
    for (const invoke of calls) {
      await expect(invoke()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    for (const method of Object.values(service)) {
      expect(method).not.toHaveBeenCalled();
    }
  });
  it('returns account metadata without server environment or profile paths', async () => {
    const { caller } = setup({
      isLocal: true,
      remoteAddress: '127.0.0.1',
      origin: 'http://localhost:3000',
    });
    await expect(caller.list()).resolves.toEqual([account]);
  });
  it('validates and trims names before creating an account', async () => {
    const { caller, service } = setup();
    await expect(caller.create({ label: '   ' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(service.createAccount).not.toHaveBeenCalled();
    await expect(caller.create({ label: ' Secondary ' })).resolves.toEqual(account);
    expect(service.createAccount).toHaveBeenCalledExactlyOnceWith('Secondary');
  });
  it('keeps login and usage operations bound to the selected account', async () => {
    const { caller, service } = setup();
    await expect(caller.startLogin({ id: account.id })).resolves.toMatchObject({
      accountId: account.id,
      status: 'pending',
    });
    await expect(caller.loginStatus({ id: account.id })).resolves.toEqual({
      accountId: account.id,
      status: 'completed',
    });
    await expect(caller.getUsage({ id: account.id })).resolves.toEqual(usage);
    await caller.cancelLogin({ id: account.id });
    for (const method of [
      service.startLogin,
      service.getLoginStatus,
      service.getUsage,
      service.cancelLogin,
    ]) {
      expect(method).toHaveBeenCalledExactlyOnceWith(account.id);
    }
  });
});
