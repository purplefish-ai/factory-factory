import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { NATIVE_DEFAULT_CODEX_ACCOUNT_ID } from '@/shared/codex-accounts';
import { nativeEmailFallbackKey } from './identity';
import { type NativeRpc, withNativeRpc } from './native-rpc';
import { codexQuotaModelScopes, normalizeCodexPlanUsage } from './normalize-usage';
import type {
  AccountIdentity,
  AccountObservation,
  CodexRuntimeContext,
  NativeLogin,
  NativeModel,
} from './types';
const accountSchema = z.object({
  account: z
    .object({
      type: z.string(),
      email: z.string().nullish(),
      planType: z.string().nullish(),
    })
    .nullable(),
});
const modelPageSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      model: z.string().optional(),
      isDefault: z.boolean().default(false),
    })
  ),
  nextCursor: z.string().nullish(),
});
async function readModels(rpc: NativeRpc): Promise<NativeModel[]> {
  const models: NativeModel[] = [];
  let cursor: string | null | undefined;
  const seen = new Set<string>();
  do {
    const page = modelPageSchema.parse(
      await rpc.request('model/list', {
        cursor: cursor ?? null,
        limit: 100,
        includeHidden: false,
      })
    );
    models.push(...page.data.map((model) => ({ ...model, model: model.model ?? model.id })));
    cursor = page.nextCursor;
    if (cursor && (seen.has(cursor) || seen.size >= 10)) {
      throw new Error('Invalid Codex model pagination');
    }
    if (cursor) {
      seen.add(cursor);
    }
  } while (cursor);
  return models;
}
const authMetadataSchema = z.object({ tokens: z.object({ account_id: z.string().trim().min(1) }) });
const effectiveStoreSchema = z.object({
  config: z.object({ cli_auth_credentials_store: z.literal('file') }),
});
async function readIdentity(
  rpc: NativeRpc,
  context: CodexRuntimeContext
): Promise<AccountIdentity> {
  const { account } = accountSchema.parse(
    await rpc.request('account/read', { refreshToken: false })
  );
  let identityKey: string | null = null;
  let scopeVerified = false;
  const nativeDefault = context.accountId === NATIVE_DEFAULT_CODEX_ACCOUNT_ID;
  if (account?.type === 'chatgpt' && account.email) {
    let fileStore = !nativeDefault;
    if (nativeDefault) {
      try {
        fileStore = effectiveStoreSchema.safeParse(
          await rpc.request('config/read', { includeLayers: false })
        ).success;
      } catch {
        fileStore = false;
      }
      // Preserve legacy keyring compatibility while pinning what native status can
      // verify. A tagged email identity is never treated as a verified quota scope.
      identityKey = nativeEmailFallbackKey(account.email);
    }
    if (fileStore) {
      try {
        // Narrow Zod projection discards credential fields. Token values are never
        // accessed, returned, logged, copied, or stored by this metadata reader.
        const value: unknown = JSON.parse(
          await readFile(join(context.homeDir, 'auth.json'), 'utf8')
        );
        const metadata = authMetadataSchema.parse(value);
        identityKey = createHash('sha256')
          .update(
            JSON.stringify([
              'account-scope',
              account.email.trim().toLowerCase(),
              metadata.tokens.account_id,
            ])
          )
          .digest('hex');
        scopeVerified = true;
      } catch {
        /* Absent metadata cannot establish a managed/file account scope. */
      }
    }
  }
  return {
    authenticated: account !== null,
    identityKey,
    scopeVerified,
    email: account?.email ?? null,
    planType: account?.planType ?? null,
  };
}
export function probeNativeIdentity(context: CodexRuntimeContext): Promise<AccountIdentity> {
  return withNativeRpc(context, (rpc) => readIdentity(rpc, context));
}
export function probeNativeAccount(context: CodexRuntimeContext): Promise<AccountObservation> {
  return withNativeRpc(context, async (rpc) => {
    const identity = await readIdentity(rpc, context);
    let usage: AccountObservation['usage'] = {
      provider: 'CODEX',
      status: 'unavailable',
      windows: [],
      updatedAt: new Date().toISOString(),
    };
    if (!identity.authenticated) {
      return { ...identity, usage, models: [] };
    }
    let usageModelScopes: Record<string, string | null> = {};
    try {
      const response = await rpc.request('account/rateLimits/read');
      usage = {
        ...normalizeCodexPlanUsage(response),
        provider: 'CODEX',
        updatedAt: new Date().toISOString(),
      };
      usageModelScopes = codexQuotaModelScopes(response);
    } catch {
      /* Quota can be unavailable while authentication remains usable. */
    }
    const modelCatalog = await readModels(rpc);
    return {
      ...identity,
      usage,
      usageModelScopes,
      modelCatalog,
      models: [...new Set(modelCatalog.flatMap((model) => [model.id, model.model]))],
    };
  });
}
const loginResponse = z.object({
  type: z.literal('chatgpt'),
  loginId: z.string(),
  authUrl: z.string().url(),
});
const loginCompleted = z.object({ loginId: z.string().nullable(), success: z.boolean() });
export function validateAuthorizationUrl(url: string): string {
  const parsed = new URL(url);
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== 'auth.openai.com' ||
    parsed.port ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error('Invalid Codex authorization URL');
  }
  return parsed.toString();
}
export const loginNativeAccount: NativeLogin = async (context, signal, onUrl) => {
  await withNativeRpc(
    context,
    async (rpc) => {
      let resolveComplete!: (value: z.infer<typeof loginCompleted>) => void;
      const completed = new Promise<z.infer<typeof loginCompleted>>((resolve) => {
        resolveComplete = resolve;
      });
      rpc.notification('account/login/completed', (value) => {
        const parsed = loginCompleted.safeParse(value);
        if (parsed.success) {
          resolveComplete(parsed.data);
        }
      });
      const result = loginResponse.parse(
        await rpc.request('account/login/start', { type: 'chatgpt' })
      );
      onUrl(validateAuthorizationUrl(result.authUrl));
      const outcome = await completed;
      if (!outcome.success || outcome.loginId !== result.loginId) {
        throw new Error('Codex login was not completed');
      }
    },
    { signal, timeoutMs: 5 * 60_000 }
  );
};
