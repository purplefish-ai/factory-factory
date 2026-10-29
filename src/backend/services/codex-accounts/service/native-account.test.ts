import { beforeEach, expect, it, vi } from 'vitest';
import { loginNativeAccount, probeNativeAccount, validateAuthorizationUrl } from './native-account';
const mocks = vi.hoisted(() => ({ request: vi.fn(), notification: vi.fn(), readFile: vi.fn() }));
vi.mock('node:fs/promises', () => ({ readFile: mocks.readFile }));
vi.mock('./native-rpc', () => ({
  withNativeRpc: async (_context: unknown, operation: (rpc: typeof mocks) => Promise<unknown>) =>
    operation(mocks),
}));
const context = {
  accountId: 'test',
  homeDir: '/private/account',
  sessionsDir: '/private/account/sessions',
  env: {},
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.readFile.mockResolvedValue(
    JSON.stringify({
      tokens: {
        account_id: 'scope-one',
        access_token: 'private-test-token',
        id_token: 'private-test-token',
      },
    })
  );
});
it('reads isolated identity, model availability and all quota buckets without exposing native fields', async () => {
  mocks.request.mockImplementation((method: string) => {
    if (method === 'account/read') {
      return {
        account: {
          type: 'chatgpt',
          email: 'person@example.com',
          planType: 'pro',
          secret: 'do-not-expose',
        },
      };
    }
    if (method === 'account/rateLimits/read') {
      return {
        rateLimitsByLimitId: {
          codex: { primary: { usedPercent: 30, windowDurationMins: 300 } },
          'gpt-test': { primary: { usedPercent: 100 } },
        },
      };
    }
    return { data: [{ id: 'gpt-test' }], nextCursor: null };
  });
  const result = await probeNativeAccount(context);
  expect(result.authenticated).toBe(true);
  expect(result.identityKey).toMatch(/^[a-f0-9]{64}$/);
  expect(result.models).toEqual(['gpt-test']);
  expect(result.usage.windows.map((window) => window.usedPercent)).toEqual([30, 100]);
  expect(JSON.stringify(result)).not.toContain('do-not-expose');
});
it('requires a matching successful native browser completion', async () => {
  let complete!: (value: unknown) => void;
  mocks.notification.mockImplementation((_method: string, listener: typeof complete) => {
    complete = listener;
  });
  mocks.request.mockImplementation(() => {
    queueMicrotask(() => complete({ loginId: 'login', success: true }));
    return {
      type: 'chatgpt',
      loginId: 'login',
      authUrl: 'https://auth.openai.com/oauth/authorize?client_id=native',
    };
  });
  const urls: string[] = [];
  await loginNativeAccount(context, new AbortController().signal, (url) => urls.push(url));
  expect(urls).toEqual(['https://auth.openai.com/oauth/authorize?client_id=native']);
});
it.each([
  'http://auth.openai.com/login',
  'https://auth.openai.com.evil.test/login',
  'https://person@auth.openai.com/login',
  'https://auth.openai.com:1455/login',
])('rejects an untrusted authorization URL %s', (url) => {
  expect(() => validateAuthorizationUrl(url)).toThrow('authorization URL');
});
it('drains auth status without exposing unavailable credentials', async () => {
  mocks.request.mockResolvedValue({ account: null });
  const result = await probeNativeAccount(context);
  expect(result.authenticated).toBe(false);
  expect(result.usage.status).toBe('unavailable');
});
it('accepts null identity metadata and leaves it visibly unverified', async () => {
  mocks.request.mockImplementation((method: string) =>
    method === 'account/read'
      ? { account: { type: 'chatgpt', email: null, planType: null } }
      : method === 'model/list'
        ? { data: [], nextCursor: null }
        : {}
  );
  const result = await probeNativeAccount(context);
  expect(result.email).toBeNull();
  expect(result.planType).toBeNull();
  expect(result.identityKey).toBeNull();
});

it('distinguishes provider account scopes sharing the same verified native email', async () => {
  mocks.request.mockImplementation((method: string) =>
    method === 'account/read'
      ? { account: { type: 'chatgpt', email: 'same@example.com', planType: 'pro' } }
      : method === 'model/list'
        ? { data: [], nextCursor: null }
        : {}
  );
  const one = await probeNativeAccount(context);
  mocks.readFile.mockResolvedValue(
    JSON.stringify({ tokens: { account_id: 'scope-two', access_token: 'private-test-token' } })
  );
  const two = await probeNativeAccount(context);
  expect(one.identityKey).not.toBe(two.identityKey);
  expect(JSON.stringify(one)).not.toContain('private-test-token');
  expect(JSON.stringify(two)).not.toContain('scope-two');
});
it('leaves native keyring scope unverified when no account-id metadata file exists', async () => {
  mocks.request.mockImplementation((method: string) =>
    method === 'account/read'
      ? { account: { type: 'chatgpt', email: 'same@example.com', planType: 'pro' } }
      : method === 'model/list'
        ? { data: [], nextCursor: null }
        : {}
  );
  mocks.readFile.mockRejectedValue(new Error('missing file'));
  expect((await probeNativeAccount(context)).identityKey).toBeNull();
});
it('requires effective file-store evidence before trusting native-default metadata and pins keyring email fallback', async () => {
  const native = { ...context, accountId: 'codex-native-default' };
  let email = 'one@example.com';
  mocks.request.mockImplementation((method: string) =>
    method === 'account/read'
      ? { account: { type: 'chatgpt', email, planType: 'pro' } }
      : method === 'config/read'
        ? { config: { cli_auth_credentials_store: 'keyring' } }
        : method === 'model/list'
          ? { data: [], nextCursor: null }
          : {}
  );
  const original = await probeNativeAccount(native);
  expect(original.identityKey).toMatch(/^native-email:[a-f0-9]{64}$/);
  expect(original.scopeVerified).toBe(false);
  expect(mocks.readFile).not.toHaveBeenCalled();
  email = 'two@example.com';
  expect((await probeNativeAccount(native)).identityKey).not.toBe(original.identityKey);
});
it('verifies native-default file scope only when native effective configuration confirms file storage', async () => {
  mocks.request.mockImplementation((method: string) =>
    method === 'account/read'
      ? { account: { type: 'chatgpt', email: 'one@example.com', planType: 'pro' } }
      : method === 'config/read'
        ? { config: { cli_auth_credentials_store: 'file' } }
        : method === 'model/list'
          ? { data: [], nextCursor: null }
          : {}
  );
  const result = await probeNativeAccount({ ...context, accountId: 'codex-native-default' });
  expect(result.scopeVerified).toBe(true);
  expect(mocks.readFile).toHaveBeenCalled();
});
