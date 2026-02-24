import type {
  ChatMessageHandler,
  HandlerRegistryDependencies,
} from '@/backend/domains/session/chat/chat-message-handlers/types';
import { buildQueuedMessage } from '@/backend/domains/session/chat/chat-message-handlers/utils';
import { codexSessionHistoryLoaderService } from '@/backend/domains/session/data/codex-session-history-loader.service';
import { claudeSessionHistoryLoaderService } from '@/backend/domains/session/data/session-history-loader.service';
import { sessionService } from '@/backend/domains/session/lifecycle/session.service';
import { sessionDomainService } from '@/backend/domains/session/session-domain.service';
import { buildTranscriptFromHistory } from '@/backend/domains/session/store/session-transcript';
import { slashCommandCacheService } from '@/backend/domains/session/store/slash-command-cache.service';
import { agentSessionAccessor } from '@/backend/resource_accessors/agent-session.accessor';
import { createLogger } from '@/backend/services/logger.service';
import { MessageState, resolveSelectedModel } from '@/shared/acp-protocol';
import type { LoadSessionMessage } from '@/shared/websocket';

const logger = createLogger('load-session-handler');
const HISTORY_READ_RETRY_COOLDOWN_MS = 30_000;
const MAX_TRACKED_HISTORY_RETRY_SESSIONS = 1024;
const nextHistoryRetryAtBySession = new Map<string, number>();

function pruneExpiredHistoryRetryEntries(now: number): void {
  for (const [trackedSessionId, retryAt] of nextHistoryRetryAtBySession) {
    if (retryAt <= now) {
      nextHistoryRetryAtBySession.delete(trackedSessionId);
    }
  }
}

function evictHistoryRetryEntryWithEarliestRetryAt(): void {
  let sessionIdToEvict: string | undefined;
  let earliestRetryAt = Number.POSITIVE_INFINITY;

  for (const [trackedSessionId, retryAt] of nextHistoryRetryAtBySession) {
    if (retryAt < earliestRetryAt) {
      earliestRetryAt = retryAt;
      sessionIdToEvict = trackedSessionId;
    }
  }

  if (sessionIdToEvict) {
    nextHistoryRetryAtBySession.delete(sessionIdToEvict);
  }
}

function setHistoryRetryAt(sessionId: string, retryAt: number): void {
  const now = Date.now();
  pruneExpiredHistoryRetryEntries(now);
  if (
    !nextHistoryRetryAtBySession.has(sessionId) &&
    nextHistoryRetryAtBySession.size >= MAX_TRACKED_HISTORY_RETRY_SESSIONS
  ) {
    evictHistoryRetryEntryWithEarliestRetryAt();
  }
  nextHistoryRetryAtBySession.set(sessionId, retryAt);
}

function canAttemptHistoryHydration(sessionId: string): boolean {
  const now = Date.now();
  pruneExpiredHistoryRetryEntries(now);
  const retryAt = nextHistoryRetryAtBySession.get(sessionId);
  if (!retryAt) {
    return true;
  }
  return retryAt <= now;
}

export function resetHistoryRetryCooldownStateForTests(): void {
  nextHistoryRetryAtBySession.clear();
}

export function createLoadSessionHandler(
  deps: HandlerRegistryDependencies
): ChatMessageHandler<LoadSessionMessage> {
  return async ({ ws, sessionId, message }) => {
    const dbSession = await agentSessionAccessor.findById(sessionId);
    if (!dbSession) {
      ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
      return;
    }

    await hydrateProviderHistoryIfNeeded(sessionId, dbSession);

    const sessionRuntime = sessionService.getRuntimeSnapshot(sessionId);
    await sessionDomainService.subscribe({
      sessionId,
      sessionRuntime,
      loadRequestId: message.loadRequestId,
    });

    logger.debug('Skipping ACP runtime init on passive session load', {
      sessionId,
      status: dbSession.status,
      processState: sessionRuntime.processState,
      hasWorktreePath: Boolean(dbSession.workspace.worktreePath),
      provider: dbSession.provider,
      isWorkspaceArchived:
        dbSession.workspace.status === 'ARCHIVING' || dbSession.workspace.status === 'ARCHIVED',
    });

    const chatCapabilities = await sessionService.getChatBarCapabilities(sessionId);
    sessionDomainService.emitDelta(sessionId, {
      type: 'chat_capabilities',
      capabilities: chatCapabilities,
    });
    const configOptions = await sessionService.getSessionConfigOptionsWithFallback(sessionId);
    if (configOptions.length > 0) {
      sessionDomainService.emitDelta(sessionId, {
        type: 'config_options_update',
        configOptions,
      });
    }

    await sendCachedSlashCommandsIfNeeded(sessionId, dbSession.provider);

    // Auto-enqueue initial message if one was stored during session creation
    await enqueueInitialMessageIfPresent(sessionId, deps);
  };
}

async function hydrateProviderHistoryIfNeeded(
  sessionId: string,
  dbSession: NonNullable<Awaited<ReturnType<typeof agentSessionAccessor.findById>>>
): Promise<void> {
  if (dbSession.provider !== 'CLAUDE' && dbSession.provider !== 'CODEX') {
    return;
  }

  if (sessionDomainService.isHistoryHydrated(sessionId)) {
    return;
  }

  const transcriptCount = sessionDomainService.getTranscriptSnapshot(sessionId).length;
  if (transcriptCount > 0) {
    sessionDomainService.markHistoryHydrated(sessionId, 'none');
    return;
  }

  if (!dbSession.providerSessionId) {
    nextHistoryRetryAtBySession.delete(sessionId);
    sessionDomainService.markHistoryHydrated(sessionId, 'none');
    return;
  }

  if (!canAttemptHistoryHydration(sessionId)) {
    logger.debug('Skipping provider JSONL history hydration during retry cooldown', {
      sessionId,
      provider: dbSession.provider,
      providerSessionId: dbSession.providerSessionId,
      retryAfterMs: HISTORY_READ_RETRY_COOLDOWN_MS,
    });
    return;
  }

  const loadStart = Date.now();
  const loadResult =
    dbSession.provider === 'CLAUDE'
      ? await claudeSessionHistoryLoaderService.loadSessionHistory({
          providerSessionId: dbSession.providerSessionId,
          workingDir: dbSession.workspace.worktreePath ?? '',
        })
      : await codexSessionHistoryLoaderService.loadSessionHistory({
          providerSessionId: dbSession.providerSessionId,
          workingDir: dbSession.workspace.worktreePath ?? '',
        });

  if (loadResult.status === 'loaded') {
    nextHistoryRetryAtBySession.delete(sessionId);
    const transcript = buildTranscriptFromHistory(loadResult.history);
    sessionDomainService.replaceTranscript(sessionId, transcript, { historySource: 'jsonl' });
    logger.debug('Hydrated provider transcript from JSONL history', {
      sessionId,
      provider: dbSession.provider,
      providerSessionId: dbSession.providerSessionId,
      filePath: loadResult.filePath,
      historyCount: loadResult.history.length,
      transcriptCount: transcript.length,
      loadDurationMs: Date.now() - loadStart,
    });
    return;
  }

  if (loadResult.status === 'error') {
    setHistoryRetryAt(sessionId, Date.now() + HISTORY_READ_RETRY_COOLDOWN_MS);
    logger.warn('Provider JSONL history hydration failed; keeping session eligible for retry', {
      sessionId,
      provider: dbSession.provider,
      providerSessionId: dbSession.providerSessionId,
      filePath: loadResult.filePath,
    });
    return;
  }

  nextHistoryRetryAtBySession.delete(sessionId);
  sessionDomainService.markHistoryHydrated(sessionId, 'none');
  logger.debug('Provider JSONL history not available; skipping runtime fallback hydration', {
    sessionId,
    provider: dbSession.provider,
    providerSessionId: dbSession.providerSessionId,
    loadStatus: loadResult.status,
  });
}

async function enqueueInitialMessageIfPresent(
  sessionId: string,
  deps: HandlerRegistryDependencies
): Promise<void> {
  const text = sessionDomainService.consumeInitialMessage(sessionId);
  if (!text) {
    return;
  }

  const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const queuedMsg = buildQueuedMessage(id, { id, text, type: 'queue_message' }, text);
  const result = sessionDomainService.enqueue(sessionId, queuedMsg);
  if ('error' in result) {
    return;
  }

  sessionDomainService.emitDelta(sessionId, {
    type: 'message_state_changed',
    id,
    newState: MessageState.ACCEPTED,
    queuePosition: result.position,
    userMessage: {
      text: queuedMsg.text,
      timestamp: queuedMsg.timestamp,
      settings: {
        ...queuedMsg.settings,
        selectedModel: resolveSelectedModel(queuedMsg.settings.selectedModel),
        reasoningEffort: queuedMsg.settings.reasoningEffort,
      },
    },
  });

  await deps.tryDispatchNextMessage(sessionId);
}

async function sendCachedSlashCommandsIfNeeded(
  sessionId: string,
  provider: 'CLAUDE' | 'CODEX'
): Promise<void> {
  const cached = await slashCommandCacheService.getCachedCommands(provider);
  if (!cached || cached.length === 0) {
    return;
  }

  const slashCommandsMsg = {
    type: 'slash_commands',
    slashCommands: cached,
  } as const;
  sessionDomainService.emitDelta(sessionId, slashCommandsMsg);
}
