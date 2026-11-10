import type { CodexRuntimeContext } from '@/backend/services/codex-accounts';
import type { AcpRuntimeManager } from '@/backend/services/session/service/acp';
import {
  getProviderHistorySessionId,
  type ProviderHistorySession,
} from '@/backend/services/session/service/data/session-provider-history-hydrator';
import type { AcpEventProcessor } from '@/backend/services/session/service/events/acp-event-processor';
import type { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { isLocalTranscriptMessage } from '@/backend/services/session/service/store/session-local-transcript';
import type { SessionContext } from './session-context.service';

export type SessionStartupHistoryDependencies = {
  hydrateProviderHistory: (
    sessionId: string,
    session: ProviderHistorySession,
    isCurrent?: () => boolean
  ) => Promise<void>;
  sessionDomainService: Pick<
    SessionDomainService,
    'getHistoryHydrationSource' | 'getTranscriptSnapshot' | 'createProviderHistoryFence'
  >;
  runtimeManager: Pick<AcpRuntimeManager, 'getClient' | 'getPendingClient'>;
};

const pendingPreparations = new WeakMap<
  SessionStartupHistoryDependencies,
  Map<string, { promise: Promise<boolean>; isCurrent: () => boolean }>
>();

/** Restore original timestamps before ACP can replay history with receipt-time timestamps. */
export function prepareSessionHistoryForResume(
  sessionId: string,
  context: SessionContext,
  dependencies: SessionStartupHistoryDependencies,
  codexAccountContext?: CodexRuntimeContext,
  isCurrent?: () => boolean
): Promise<boolean | undefined> {
  const preparations =
    pendingPreparations.get(dependencies) ??
    new Map<string, { promise: Promise<boolean>; isCurrent: () => boolean }>();
  pendingPreparations.set(dependencies, preparations);
  const providerSessionId = getProviderHistorySessionId({
    ...context.session,
    workspace: { worktreePath: context.workingDir },
  });
  const key = JSON.stringify([sessionId, providerSessionId]);
  const existing = preparations.get(key);
  if (existing?.isCurrent()) {
    return existing.promise;
  }
  // A pending adapter may still depend on this preparation. Join it above so
  // a queued creator cannot bypass hydration after that adapter fails to initialize.
  // Established fallback replay without a pending preparation keeps its owner.
  if (
    dependencies.runtimeManager.getClient(sessionId) ||
    (!existing && dependencies.runtimeManager.getPendingClient(sessionId))
  ) {
    return Promise.resolve(undefined);
  }
  const providerIsCurrent = dependencies.sessionDomainService.createProviderHistoryFence(
    sessionId,
    providerSessionId
  );
  const preparationIsCurrent = () => Boolean(providerIsCurrent?.()) && (isCurrent?.() ?? true);
  const preparation = hydrateSessionHistory(
    sessionId,
    context,
    dependencies,
    codexAccountContext,
    preparationIsCurrent
  ).finally(() => {
    if (preparations.get(key)?.promise === preparation) {
      preparations.delete(key);
    }
  });
  preparations.set(key, { promise: preparation, isCurrent: preparationIsCurrent });
  return preparation;
}

async function hydrateSessionHistory(
  sessionId: string,
  context: SessionContext,
  dependencies: SessionStartupHistoryDependencies,
  codexAccountContext?: CodexRuntimeContext,
  isCurrent?: () => boolean
): Promise<boolean> {
  const hadProviderTranscript = dependencies.sessionDomainService
    .getTranscriptSnapshot(sessionId)
    .some((message) => !isLocalTranscriptMessage(message));
  await dependencies.hydrateProviderHistory(
    sessionId,
    {
      ...context.session,
      ...(codexAccountContext ? { codexAccountContext } : {}),
      workspace: { worktreePath: context.workingDir },
    },
    isCurrent
  );
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
  codexAccountContext?: CodexRuntimeContext,
  isCurrent?: () => boolean
): () => Promise<void> {
  const providerSessionId = getProviderHistorySessionId({
    ...context.session,
    workspace: { worktreePath: context.workingDir },
  });
  const historyIsCurrent = dependencies.sessionDomainService.createProviderHistoryFence(
    sessionId,
    providerSessionId
  );
  const history = prepareSessionHistoryForResume(
    sessionId,
    context,
    dependencies,
    codexAccountContext,
    isCurrent
  );
  // Adapter initialization can fail before it consumes the barrier. Own that
  // rejection immediately; awaiting the original promise still propagates it.
  void history.catch(() => undefined);
  return async () => {
    const suppressReplay = await history;
    await assertCurrent();
    if ((isCurrent?.() ?? true) && historyIsCurrent?.() && suppressReplay !== undefined) {
      dependencies.acpEventProcessor.setReplaySuppression(sessionId, suppressReplay);
    }
  };
}
