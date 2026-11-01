import { z } from 'zod';
import { NATIVE_DEFAULT_CODEX_ACCOUNT_ID } from '@/shared/codex-accounts';
import { withNativeRpc } from './native-rpc';
import type { CodexRuntimeContext } from './types';

const configSchema = z.object({
  config: z.object({
    cli_auth_credentials_store: z.enum(['file', 'keyring', 'auto', 'ephemeral']).optional(),
  }),
});

/** Carry only the effective authentication store into otherwise isolated inference. */
export function getMetadataCredentialsStore(context: CodexRuntimeContext, signal: AbortSignal) {
  if (context.accountId !== NATIVE_DEFAULT_CODEX_ACCOUNT_ID) {
    return Promise.resolve('file' as const);
  }
  return withNativeRpc(
    context,
    async (rpc) => {
      const config = configSchema.parse(await rpc.request('config/read', { includeLayers: false }));
      return config.config.cli_auth_credentials_store ?? 'file';
    },
    { signal }
  );
}
