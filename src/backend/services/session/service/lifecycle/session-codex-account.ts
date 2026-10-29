import {
  codexAccountService,
  NATIVE_DEFAULT_CODEX_ACCOUNT_ID,
} from '@/backend/services/codex-accounts';
import type { AgentSessionRecord } from '@/backend/services/session/resources/agent-session.accessor';

export type SessionCodexAccountPort = Pick<typeof codexAccountService, 'getRuntimeContext'>;

export function resolveSessionCodexContext(
  session: AgentSessionRecord,
  accounts: SessionCodexAccountPort = codexAccountService
) {
  return session.provider === 'CODEX'
    ? accounts.getRuntimeContext(session.codexAccountId ?? NATIVE_DEFAULT_CODEX_ACCOUNT_ID)
    : Promise.resolve(undefined);
}

export function assertSessionAccountBinding(
  session: AgentSessionRecord,
  latest: AgentSessionRecord
): void {
  if (latest.provider !== session.provider || latest.codexAccountId !== session.codexAccountId) {
    throw new Error('Session account binding changed during startup');
  }
}
