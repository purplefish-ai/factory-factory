import { codexAccountService } from '@/backend/services/codex-accounts';
import { fetchSessionLaunchOptionsFromAcp } from '@/backend/services/session/service/acp/session-launch-options-probe';

/** Admission and account selection stay outside the provider protocol implementation. */
export async function fetchAccountSessionLaunchOptions(input: {
  provider: 'CLAUDE' | 'CODEX';
  model?: string;
  codexAccountId?: string;
}) {
  const context =
    input.provider === 'CODEX'
      ? await codexAccountService.getPreviewRuntimeContext({
          accountId: input.codexAccountId,
          model: input.model,
        })
      : undefined;
  return fetchSessionLaunchOptionsFromAcp({
    provider: input.provider,
    model: input.model,
    ...(context ? { env: context.env } : {}),
  });
}
