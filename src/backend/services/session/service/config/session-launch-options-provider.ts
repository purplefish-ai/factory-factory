import { codexAccountService } from '@/backend/services/codex-accounts';
import { timeLaunchDiscovery } from '@/backend/services/session/service/acp/launch-discovery-timing';
import { fetchSessionLaunchOptionsFromAcp } from '@/backend/services/session/service/acp/session-launch-options-probe';

/** Admission and account selection stay outside the provider protocol implementation. */
export async function fetchAccountSessionLaunchOptions(
  input: {
    provider: 'CLAUDE' | 'CODEX';
    model?: string;
    codexAccountId?: string;
  },
  signal?: AbortSignal
) {
  signal?.throwIfAborted();
  const context =
    input.provider === 'CODEX'
      ? await timeLaunchDiscovery('account resolution', input, () =>
          codexAccountService.getPreviewRuntimeContext({
            accountId: input.codexAccountId,
            model: input.model,
          })
        )
      : undefined;
  signal?.throwIfAborted();
  return fetchSessionLaunchOptionsFromAcp({
    ...(signal ? { signal } : {}),
    provider: input.provider,
    model: input.model,
    ...(context ? { env: context.env } : {}),
  });
}
