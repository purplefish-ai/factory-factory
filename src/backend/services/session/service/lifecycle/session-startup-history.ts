import type { AcpRuntimeManager } from '@/backend/services/session/service/acp';
import type { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { isLocalTranscriptMessage } from '@/backend/services/session/service/store/session-local-transcript';
import type { SessionContext } from './session-context.service';
import type { ProviderHistorySession } from './session-provider-history-hydrator';

export type SessionStartupHistoryDependencies = {
  hydrateProviderHistory: (sessionId: string, session: ProviderHistorySession) => Promise<void>;
  sessionDomainService: Pick<
    SessionDomainService,
    'getHistoryHydrationSource' | 'getTranscriptSnapshot'
  >;
  runtimeManager: Pick<AcpRuntimeManager, 'getClient' | 'getPendingClient'>;
};

const pendingPreparations = new WeakMap<
  SessionStartupHistoryDependencies,
  Map<string, Promise<boolean>>
>();

/** Restore original timestamps before ACP can replay history with receipt-time timestamps. */
export function prepareSessionHistoryForResume(
  sessionId: string,
  context: SessionContext,
  dependencies: SessionStartupHistoryDependencies
): Promise<boolean | undefined> {
  // Another startup owns any replay already underway. Do not mutate its history
  // or suppression policy while joining that runtime.
  if (
    dependencies.runtimeManager.getClient(sessionId) ||
    dependencies.runtimeManager.getPendingClient(sessionId)
  ) {
    return Promise.resolve(undefined);
  }
  const preparations = pendingPreparations.get(dependencies) ?? new Map<string, Promise<boolean>>();
  pendingPreparations.set(dependencies, preparations);
  const key = JSON.stringify([sessionId, context.session.providerSessionId]);
  const existing = preparations.get(key);
  if (existing) {
    return existing;
  }
  const preparation = hydrateSessionHistory(sessionId, context, dependencies).finally(() => {
    preparations.delete(key);
  });
  preparations.set(key, preparation);
  return preparation;
}

async function hydrateSessionHistory(
  sessionId: string,
  context: SessionContext,
  dependencies: SessionStartupHistoryDependencies
): Promise<boolean> {
  const hadProviderTranscript = dependencies.sessionDomainService
    .getTranscriptSnapshot(sessionId)
    .some((message) => !isLocalTranscriptMessage(message));
  await dependencies.hydrateProviderHistory(sessionId, {
    ...context.session,
    workspace: { worktreePath: context.workingDir },
  });
  return Boolean(
    context.session.providerSessionId &&
    (hadProviderTranscript ||
      dependencies.sessionDomainService.getHistoryHydrationSource(sessionId) === 'jsonl') &&
    dependencies.sessionDomainService
      .getTranscriptSnapshot(sessionId)
      .some((message) => !isLocalTranscriptMessage(message))
  );
}
