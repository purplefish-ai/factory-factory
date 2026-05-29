import { createLogger } from '@/backend/services/logger.service';
import { agentSessionAccessor } from '@/backend/services/session/resources/agent-session.accessor';
import type {
  ChatMessageHandler,
  HandlerRegistryDependencies,
} from '@/backend/services/session/service/chat/chat-message-handlers/types';
import {
  buildAcceptedMessageStateChange,
  buildQueuedMessage,
} from '@/backend/services/session/service/chat/chat-message-handlers/utils';
import { codexSessionHistoryLoaderService } from '@/backend/services/session/service/data/codex-session-history-loader.service';
import { claudeSessionHistoryLoaderService } from '@/backend/services/session/service/data/session-history-loader.service';
import { sessionService } from '@/backend/services/session/service/lifecycle/session.service';
import { sessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { buildTranscriptFromHistory } from '@/backend/services/session/service/store/session-transcript';
import { slashCommandCacheService } from '@/backend/services/session/service/store/slash-command-cache.service';
import type { ChatMessage } from '@/shared/acp-protocol';
import type { LoadSessionMessage } from '@/shared/websocket';

const logger = createLogger('load-session-handler');
const HISTORY_READ_RETRY_COOLDOWN_MS = 30_000;
type ProviderSessionRecord = NonNullable<Awaited<ReturnType<typeof agentSessionAccessor.findById>>>;
type ProviderHistoryLoadResult =
  | Awaited<ReturnType<typeof claudeSessionHistoryLoaderService.loadSessionHistory>>
  | Awaited<ReturnType<typeof codexSessionHistoryLoaderService.loadSessionHistory>>;
type LoadedProviderHistory = Extract<ProviderHistoryLoadResult, { status: 'loaded' }>;

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
  dbSession: ProviderSessionRecord
): Promise<void> {
  if (dbSession.provider !== 'CLAUDE' && dbSession.provider !== 'CODEX') {
    return;
  }

  const existingTranscript = sessionDomainService.getTranscriptSnapshot(sessionId);
  const shouldAttemptCodexToolBackfill =
    dbSession.provider === 'CODEX' &&
    existingTranscript.length > 0 &&
    Boolean(dbSession.providerSessionId);

  if (sessionDomainService.isHistoryHydrated(sessionId) && !shouldAttemptCodexToolBackfill) {
    return;
  }

  if (existingTranscript.length > 0 && dbSession.provider !== 'CODEX') {
    sessionDomainService.markHistoryHydrated(sessionId, 'none');
    return;
  }

  if (!dbSession.providerSessionId) {
    sessionDomainService.clearHistoryRetryCooldown(sessionId);
    sessionDomainService.markHistoryHydrated(sessionId, 'none');
    return;
  }

  if (!sessionDomainService.canAttemptHistoryHydration(sessionId)) {
    logHistoryRetryCooldownSkip(sessionId, dbSession);
    return;
  }

  const loadStart = Date.now();
  const loadResult = await loadProviderHistory(dbSession);

  if (loadResult.status === 'loaded') {
    handleLoadedProviderHistory({
      sessionId,
      dbSession,
      loadResult,
      shouldAttemptCodexToolBackfill,
      loadStart,
    });
    return;
  }

  handleUnavailableProviderHistory(sessionId, dbSession, loadResult);
}

function logHistoryRetryCooldownSkip(sessionId: string, dbSession: ProviderSessionRecord): void {
  logger.debug('Skipping provider JSONL history hydration during retry cooldown', {
    sessionId,
    provider: dbSession.provider,
    providerSessionId: dbSession.providerSessionId,
    retryAfterMs: HISTORY_READ_RETRY_COOLDOWN_MS,
  });
}

async function loadProviderHistory(
  dbSession: ProviderSessionRecord
): Promise<ProviderHistoryLoadResult> {
  const input = {
    providerSessionId: dbSession.providerSessionId ?? '',
    workingDir: dbSession.workspace.worktreePath ?? '',
  };

  if (dbSession.provider === 'CLAUDE') {
    return await claudeSessionHistoryLoaderService.loadSessionHistory(input);
  }

  return await codexSessionHistoryLoaderService.loadSessionHistory(input);
}

function handleLoadedProviderHistory({
  sessionId,
  dbSession,
  loadResult,
  shouldAttemptCodexToolBackfill,
  loadStart,
}: {
  sessionId: string;
  dbSession: ProviderSessionRecord;
  loadResult: LoadedProviderHistory;
  shouldAttemptCodexToolBackfill: boolean;
  loadStart: number;
}): void {
  sessionDomainService.clearHistoryRetryCooldown(sessionId);
  if (sessionDomainService.isHistoryHydrated(sessionId) && !shouldAttemptCodexToolBackfill) {
    return;
  }

  const transcript = buildTranscriptFromHistory(loadResult.history);
  const latestTranscript = sessionDomainService.getTranscriptSnapshot(sessionId);
  if (latestTranscript.length > 0) {
    handleLoadedHistoryWithExistingTranscript({
      sessionId,
      dbSession,
      loadResult,
      transcript,
      latestTranscript,
      loadStart,
    });
    return;
  }

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
}

function handleLoadedHistoryWithExistingTranscript({
  sessionId,
  dbSession,
  loadResult,
  transcript,
  latestTranscript,
  loadStart,
}: {
  sessionId: string;
  dbSession: ProviderSessionRecord;
  loadResult: LoadedProviderHistory;
  transcript: ChatMessage[];
  latestTranscript: ChatMessage[];
  loadStart: number;
}): void {
  if (dbSession.provider === 'CODEX') {
    backfillCodexToolTranscript({
      sessionId,
      dbSession,
      loadResult,
      transcript,
      latestTranscript,
      loadStart,
    });
    return;
  }

  sessionDomainService.markHistoryHydrated(sessionId, 'none');
  logger.debug('Skipping provider JSONL history replace because transcript is no longer empty', {
    sessionId,
    provider: dbSession.provider,
    providerSessionId: dbSession.providerSessionId,
    transcriptCount: latestTranscript.length,
    loadDurationMs: Date.now() - loadStart,
  });
}

function backfillCodexToolTranscript({
  sessionId,
  dbSession,
  loadResult,
  transcript,
  latestTranscript,
  loadStart,
}: {
  sessionId: string;
  dbSession: ProviderSessionRecord;
  loadResult: LoadedProviderHistory;
  transcript: ChatMessage[];
  latestTranscript: ChatMessage[];
  loadStart: number;
}): void {
  const backfilledTranscript = backfillMissingCodexToolTranscript(latestTranscript, transcript);
  if (!backfilledTranscript) {
    return;
  }

  sessionDomainService.replaceTranscript(sessionId, backfilledTranscript, {
    historySource: 'jsonl',
  });
  logger.debug('Backfilled missing Codex tool calls from JSONL history', {
    sessionId,
    providerSessionId: dbSession.providerSessionId,
    filePath: loadResult.filePath,
    existingTranscriptCount: latestTranscript.length,
    backfilledTranscriptCount: backfilledTranscript.length,
    loadDurationMs: Date.now() - loadStart,
  });
}

function handleUnavailableProviderHistory(
  sessionId: string,
  dbSession: ProviderSessionRecord,
  loadResult: Exclude<ProviderHistoryLoadResult, { status: 'loaded' }>
): void {
  if (loadResult.status === 'error') {
    sessionDomainService.setHistoryRetryAt(sessionId, Date.now() + HISTORY_READ_RETRY_COOLDOWN_MS);
    logger.warn('Provider JSONL history hydration failed; keeping session eligible for retry', {
      sessionId,
      provider: dbSession.provider,
      providerSessionId: dbSession.providerSessionId,
      filePath: loadResult.filePath,
    });
    return;
  }

  sessionDomainService.clearHistoryRetryCooldown(sessionId);
  sessionDomainService.markHistoryHydrated(sessionId, 'none');
  logger.debug('Provider JSONL history not available; skipping runtime fallback hydration', {
    sessionId,
    provider: dbSession.provider,
    providerSessionId: dbSession.providerSessionId,
    loadStatus: loadResult.status,
  });
}

function getToolUseId(message: ChatMessage): string | null {
  if (message.source !== 'agent' || !message.message) {
    return null;
  }

  const agentMessage = message.message;
  if (
    agentMessage.type === 'stream_event' &&
    agentMessage.event?.type === 'content_block_start' &&
    agentMessage.event.content_block.type === 'tool_use'
  ) {
    return agentMessage.event.content_block.id;
  }

  const content = agentMessage.message?.content;
  if (!Array.isArray(content)) {
    return null;
  }

  const toolUse = content.find((item) => item.type === 'tool_use');
  return toolUse?.type === 'tool_use' ? toolUse.id : null;
}

function getToolResultUseId(message: ChatMessage): string | null {
  if (message.source !== 'agent' || !message.message) {
    return null;
  }

  const content = message.message.message?.content;
  if (!Array.isArray(content)) {
    return null;
  }

  const toolResult = content.find((item) => item.type === 'tool_result');
  return toolResult?.type === 'tool_result' ? toolResult.tool_use_id : null;
}

function getCompleteHistoryToolUseIds(historyTranscript: ChatMessage[]): Set<string> {
  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();

  for (const message of historyTranscript) {
    const toolUseId = getToolUseId(message);
    if (toolUseId) {
      toolUseIds.add(toolUseId);
    }

    const toolResultId = getToolResultUseId(message);
    if (toolResultId) {
      toolResultIds.add(toolResultId);
    }
  }

  return new Set([...toolUseIds].filter((toolUseId) => toolResultIds.has(toolUseId)));
}

function normalizeTranscriptOrder(messages: ChatMessage[]): ChatMessage[] {
  return [...messages]
    .sort((left, right) => {
      const leftTime = Date.parse(left.timestamp);
      const rightTime = Date.parse(right.timestamp);
      const leftSortTime = Number.isNaN(leftTime) ? 0 : leftTime;
      const rightSortTime = Number.isNaN(rightTime) ? 0 : rightTime;
      if (leftSortTime !== rightSortTime) {
        return leftSortTime - rightSortTime;
      }
      return left.order - right.order;
    })
    .map((message, order) => ({ ...message, order }));
}

function backfillMissingCodexToolTranscript(
  existingTranscript: ChatMessage[],
  historyTranscript: ChatMessage[]
): ChatMessage[] | null {
  const completeHistoryToolUseIds = getCompleteHistoryToolUseIds(historyTranscript);
  if (completeHistoryToolUseIds.size === 0) {
    return null;
  }

  const existingToolUseIds = new Set<string>();
  const existingToolResultIds = new Set<string>();
  for (const message of existingTranscript) {
    const toolUseId = getToolUseId(message);
    if (toolUseId) {
      existingToolUseIds.add(toolUseId);
    }

    const toolResultId = getToolResultUseId(message);
    if (toolResultId) {
      existingToolResultIds.add(toolResultId);
    }
  }

  const missingToolMessages = historyTranscript.filter((message) => {
    const toolUseId = getToolUseId(message);
    if (toolUseId) {
      return completeHistoryToolUseIds.has(toolUseId) && !existingToolUseIds.has(toolUseId);
    }

    const toolResultId = getToolResultUseId(message);
    if (!toolResultId) {
      return false;
    }
    return completeHistoryToolUseIds.has(toolResultId) && !existingToolResultIds.has(toolResultId);
  });

  if (missingToolMessages.length === 0) {
    return null;
  }

  return normalizeTranscriptOrder([...existingTranscript, ...missingToolMessages]);
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

  sessionDomainService.emitDelta(
    sessionId,
    buildAcceptedMessageStateChange(id, queuedMsg, result.position)
  );

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
