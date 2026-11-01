import { afterEach, expect, it, vi } from 'vitest';
import { getMetadataCredentialsStore } from './metadata-credentials-store';
import type { CodexRuntimeContext } from './types';

const mocks = vi.hoisted(() => ({ request: vi.fn(), rpc: vi.fn() }));
vi.mock('./native-rpc', () => ({
  withNativeRpc: (
    _context: unknown,
    operation: (rpc: { request: typeof mocks.request }) => Promise<unknown>
  ) => {
    mocks.rpc();
    return operation({ request: mocks.request });
  },
}));
const context: CodexRuntimeContext = {
  accountId: 'codex-native-default',
  homeDir: '/native',
  sessionsDir: '/sessions',
  env: {},
};
afterEach(() => vi.resetAllMocks());
it('preserves native keyring authentication without carrying unrelated configuration', async () => {
  mocks.request.mockResolvedValue({
    config: {
      cli_auth_credentials_store: 'keyring',
      developer_instructions: 'Do not include this',
    },
  });
  expect(await getMetadataCredentialsStore(context, new AbortController().signal)).toBe('keyring');
  expect(mocks.request).toHaveBeenCalledWith('config/read', { includeLayers: false });
});
it('uses file credentials for managed profiles without another native query', async () => {
  expect(
    await getMetadataCredentialsStore(
      { ...context, accountId: 'managed' },
      new AbortController().signal
    )
  ).toBe('file');
  expect(mocks.rpc).not.toHaveBeenCalled();
});

it('defaults to file credentials when the native setting is absent', async () => {
  mocks.request.mockResolvedValue({ config: {} });
  expect(await getMetadataCredentialsStore(context, new AbortController().signal)).toBe('file');
});

it.each(['file', 'auto', 'ephemeral'] as const)(
  'preserves the native %s credentials store',
  async (store) => {
    mocks.request.mockResolvedValue({ config: { cli_auth_credentials_store: store } });
    expect(await getMetadataCredentialsStore(context, new AbortController().signal)).toBe(store);
  }
);
