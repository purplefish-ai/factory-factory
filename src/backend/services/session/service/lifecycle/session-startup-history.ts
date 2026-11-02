import type { CodexRuntimeContext } from '@/backend/services/codex-accounts';
import type { AcpRuntimeManager } from '@/backend/services/session/service/acp';
import type { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { isLocalTranscriptMessage } from '@/backend/services/session/service/store/session-local-transcript';
import type { AcpEventProcessor } from './acp-event-processor';
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
  dependencies: SessionStartupHistoryDependencies,
  codexAccountContext?: CodexRuntimeContext
): Promise<boolean | undefined> {
  const preparations = pendingPreparations.get(dependencies) ?? new Map<string, Promise<boolean>>();
  pendingPreparations.set(dependencies, preparations);
  const key = JSON.stringify([sessionId, context.session.providerSessionId]);
  const existing = preparations.get(key);
  if (existing) {
    return existing;
  }
  // A pending adapter may still depend on this preparation. Join it above so
  // a queued creator cannot bypass hydration after that adapter fails to initialize.
  // Established fallback replay without a pending preparation keeps its owner.
  if (
    dependencies.runtimeManager.getClient(sessionId) ||
    dependencies.runtimeManager.getPendingClient(sessionId)
  ) {
    return Promise.resolve(undefined);
  }
  const preparation = hydrateSessionHistory(
    sessionId,
    context,
    dependencies,
    codexAccountContext
  ).finally(() => {
    preparations.delete(key);
  });
  preparations.set(key, preparation);
  return preparation;
}

async function hydrateSessionHistory(
  sessionId: string,
  context: SessionContext,
  dependencies: SessionStartupHistoryDependencies,
  codexAccountContext?: CodexRuntimeContext
): Promise<boolean> {
  const hadProviderTranscript = dependencies.sessionDomainService
    .getTranscriptSnapshot(sessionId)
    .some((message) => !isLocalTranscriptMessage(message));
  await dependencies.hydrateProviderHistory(sessionId, {
    ...context.session,
    ...(codexAccountContext ? { codexAccountContext } : {}),
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

/** Begin cold history IO now, but commit suppression only before provider load/new. */
export function createSessionHistoryBarrier(
  sessionId: string,
  context: SessionContext,
  dependencies: SessionStartupHistoryDependencies & {
    acpEventProcessor: Pick<AcpEventProcessor, 'setReplaySuppression'>;
  },
  assertCurrent: () => Promise<void>,
  codexAccountContext?: CodexRuntimeContext
): () => Promise<void> {
  const history = prepareSessionHistoryForResume(
    sessionId,
    context,
    dependencies,
    codexAccountContext
  );
  // Adapter initialization can fail before it consumes the barrier. Own that
  // rejection immediately; awaiting the original promise still propagates it.
  void history.catch(() => undefined);
  return async () => {
    const suppressReplay = await history;
    await assertCurrent();
    if (suppressReplay !== undefined) {
      dependencies.acpEventProcessor.setReplaySuppression(sessionId, suppressReplay);
    }
  };
}
