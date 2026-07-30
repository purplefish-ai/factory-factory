import { createLogger } from '@/backend/services/logger.service';
import { codexSessionHistoryLoaderService } from '@/backend/services/session/service/data/codex-session-history-loader.service';
import { claudeSessionHistoryLoaderService } from '@/backend/services/session/service/data/session-history-loader.service';
import { sessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { mergeLifecycleMessage } from '@/backend/services/session/service/store/session-lifecycle-transcript';
import { buildTranscriptFromHistory } from '@/backend/services/session/service/store/session-transcript';
import type { ChatMessage } from '@/shared/acp-protocol';

const logger = createLogger('session-provider-history-hydrator');
const HISTORY_READ_RETRY_COOLDOWN_MS = 30_000;
const CODEX_TOOL_BACKFILL_RECHECK_COOLDOWN_MS = 5000;

export type ProviderHistorySession = {
  provider: 'CLAUDE' | 'CODEX';
  providerSessionId: string | null;
  providerMetadata: unknown;
  workspace: { worktreePath: string | null };
};

type ProviderHistoryLoadResult =
  | Awaited<ReturnType<typeof claudeSessionHistoryLoaderService.loadSessionHistory>>
  | Awaited<ReturnType<typeof codexSessionHistoryLoaderService.loadSessionHistory>>;
type LoadedProviderHistory = Extract<ProviderHistoryLoadResult, { status: 'loaded' }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getProviderSessionIdFromMetadata(dbSession: ProviderHistorySession): string | null {
  if (!isRecord(dbSession.providerMetadata)) {
    return null;
  }

  const snapshot = dbSession.providerMetadata.acpConfigSnapshot;
  if (!isRecord(snapshot) || snapshot.provider !== dbSession.provider) {
    return null;
  }

  const providerSessionId = snapshot.providerSessionId;
  return typeof providerSessionId === 'string' && providerSessionId.length > 0
    ? providerSessionId
    : null;
}

function getProviderSessionId(dbSession: ProviderHistorySession): string | null {
  if (typeof dbSession.providerSessionId === 'string' && dbSession.providerSessionId.length > 0) {
    return dbSession.providerSessionId;
  }
  return getProviderSessionIdFromMetadata(dbSession);
}

function isLifecycleMessage(message: ChatMessage): boolean {
  return message.source === 'agent' && message.message?.type === 'session_lifecycle';
}

function providerMessages(transcript: ChatMessage[]): ChatMessage[] {
  return transcript.filter((message) => !isLifecycleMessage(message));
}

function lifecycleMessages(transcript: ChatMessage[]): ChatMessage[] {
  return transcript.filter(isLifecycleMessage);
}

export async function hydrateProviderHistoryIfNeeded(
  sessionId: string,
  dbSession: ProviderHistorySession
): Promise<void> {
  const existingTranscript = sessionDomainService.getTranscriptSnapshot(sessionId);
  const existingProviderMessages = providerMessages(existingTranscript);
  const isHistoryHydrated = sessionDomainService.isHistoryHydrated(sessionId);
  const historyHydrationSource = isHistoryHydrated
    ? sessionDomainService.getHistoryHydrationSource(sessionId)
    : undefined;
  const providerSessionId = getProviderSessionId(dbSession);
  const shouldAttemptCodexToolBackfill =
    dbSession.provider === 'CODEX' &&
    existingProviderMessages.length > 0 &&
    Boolean(providerSessionId) &&
    historyHydrationSource !== 'jsonl';

  if (isHistoryHydrated && !shouldAttemptCodexToolBackfill) {
    return;
  }

  if (existingProviderMessages.length > 0 && dbSession.provider !== 'CODEX') {
    sessionDomainService.markHistoryHydrated(sessionId, 'none');
    return;
  }

  if (!providerSessionId) {
    sessionDomainService.clearHistoryRetryCooldown(sessionId);
    sessionDomainService.markHistoryHydrated(sessionId, 'none');
    return;
  }

  if (!sessionDomainService.canAttemptHistoryHydration(sessionId)) {
    logger.debug('Skipping provider JSONL history hydration during cooldown', {
      sessionId,
      provider: dbSession.provider,
      providerSessionId,
    });
    return;
  }

  const loadStart = Date.now();
  const loadResult = await loadProviderHistory(dbSession, providerSessionId);
  if (loadResult.status === 'loaded') {
    handleLoadedProviderHistory({
      sessionId,
      dbSession,
      providerSessionId,
      loadResult,
      shouldAttemptCodexToolBackfill,
      loadStart,
    });
    return;
  }

  handleUnavailableProviderHistory(sessionId, dbSession, providerSessionId, loadResult, {
    shouldRecheckCodexToolBackfill: shouldAttemptCodexToolBackfill,
  });
}

async function loadProviderHistory(
  dbSession: ProviderHistorySession,
  providerSessionId: string
): Promise<ProviderHistoryLoadResult> {
  const input = {
    providerSessionId,
    workingDir: dbSession.workspace.worktreePath ?? '',
  };
  return dbSession.provider === 'CLAUDE'
    ? await claudeSessionHistoryLoaderService.loadSessionHistory(input)
    : await codexSessionHistoryLoaderService.loadSessionHistory(input);
}

function handleLoadedProviderHistory({
  sessionId,
  dbSession,
  providerSessionId,
  loadResult,
  shouldAttemptCodexToolBackfill,
  loadStart,
}: {
  sessionId: string;
  dbSession: ProviderHistorySession;
  providerSessionId: string;
  loadResult: LoadedProviderHistory;
  shouldAttemptCodexToolBackfill: boolean;
  loadStart: number;
}): void {
  sessionDomainService.clearHistoryRetryCooldown(sessionId);
  if (
    sessionDomainService.getHistoryHydrationSource(sessionId) === 'jsonl' ||
    (sessionDomainService.isHistoryHydrated(sessionId) && !shouldAttemptCodexToolBackfill)
  ) {
    return;
  }

  const loadedTranscript = buildTranscriptFromHistory(loadResult.history);
  const latestTranscript = sessionDomainService.getTranscriptSnapshot(sessionId);
  const latestProviderMessages = providerMessages(latestTranscript);
  if (latestProviderMessages.length > 0) {
    handleLoadedHistoryWithExistingProviderTranscript({
      sessionId,
      dbSession,
      providerSessionId,
      loadResult,
      loadedTranscript,
      latestTranscript,
      loadStart,
    });
    return;
  }

  const retainedLifecycleMessages = lifecycleMessages(latestTranscript);
  const mergedTranscript =
    retainedLifecycleMessages.length === 0
      ? loadedTranscript
      : mergeLifecycleMessage(loadedTranscript, retainedLifecycleMessages);
  sessionDomainService.replaceTranscript(sessionId, mergedTranscript, {
    historySource: 'jsonl',
  });
  logger.debug('Hydrated provider transcript from JSONL history', {
    sessionId,
    provider: dbSession.provider,
    providerSessionId,
    filePath: loadResult.filePath,
    historyCount: loadResult.history.length,
    transcriptCount: mergedTranscript.length,
    loadDurationMs: Date.now() - loadStart,
  });
}

function handleLoadedHistoryWithExistingProviderTranscript({
  sessionId,
  dbSession,
  providerSessionId,
  loadResult,
  loadedTranscript,
  latestTranscript,
  loadStart,
}: {
  sessionId: string;
  dbSession: ProviderHistorySession;
  providerSessionId: string;
  loadResult: LoadedProviderHistory;
  loadedTranscript: ChatMessage[];
  latestTranscript: ChatMessage[];
  loadStart: number;
}): void {
  if (dbSession.provider === 'CODEX') {
    backfillCodexToolTranscript({
      sessionId,
      providerSessionId,
      loadResult,
      loadedTranscript,
      latestTranscript,
      loadStart,
    });
    return;
  }

  sessionDomainService.markHistoryHydrated(sessionId, 'none');
  logger.debug('Skipping provider JSONL history replace because provider messages arrived', {
    sessionId,
    provider: dbSession.provider,
    providerSessionId,
    transcriptCount: latestTranscript.length,
    loadDurationMs: Date.now() - loadStart,
  });
}

function backfillCodexToolTranscript({
  sessionId,
  providerSessionId,
  loadResult,
  loadedTranscript,
  latestTranscript,
  loadStart,
}: {
  sessionId: string;
  providerSessionId: string;
  loadResult: LoadedProviderHistory;
  loadedTranscript: ChatMessage[];
  latestTranscript: ChatMessage[];
  loadStart: number;
}): void {
  const backfilledTranscript = backfillMissingCodexToolTranscript(
    latestTranscript,
    loadedTranscript
  );
  if (!backfilledTranscript) {
    sessionDomainService.markHistoryHydrated(sessionId, 'none');
    scheduleCodexToolBackfillRecheck(sessionId);
    return;
  }

  sessionDomainService.replaceTranscript(sessionId, backfilledTranscript, {
    historySource: 'jsonl',
  });
  logger.debug('Backfilled missing Codex tool calls from JSONL history', {
    sessionId,
    providerSessionId,
    filePath: loadResult.filePath,
    existingTranscriptCount: latestTranscript.length,
    backfilledTranscriptCount: backfilledTranscript.length,
    loadDurationMs: Date.now() - loadStart,
  });
}

function handleUnavailableProviderHistory(
  sessionId: string,
  dbSession: ProviderHistorySession,
  providerSessionId: string,
  loadResult: Exclude<ProviderHistoryLoadResult, { status: 'loaded' }>,
  options?: { shouldRecheckCodexToolBackfill?: boolean }
): void {
  if (loadResult.status === 'error') {
    sessionDomainService.setHistoryRetryAt(sessionId, Date.now() + HISTORY_READ_RETRY_COOLDOWN_MS);
    logger.warn('Provider JSONL history hydration failed; keeping session eligible for retry', {
      sessionId,
      provider: dbSession.provider,
      providerSessionId,
      filePath: loadResult.filePath,
    });
    return;
  }

  sessionDomainService.clearHistoryRetryCooldown(sessionId);
  sessionDomainService.markHistoryHydrated(sessionId, 'none');
  if (options?.shouldRecheckCodexToolBackfill) {
    scheduleCodexToolBackfillRecheck(sessionId);
  }
  logger.debug('Provider JSONL history not available; skipping runtime fallback hydration', {
    sessionId,
    provider: dbSession.provider,
    providerSessionId,
    loadStatus: loadResult.status,
  });
}

function scheduleCodexToolBackfillRecheck(sessionId: string): void {
  sessionDomainService.setHistoryRetryAt(
    sessionId,
    Date.now() + CODEX_TOOL_BACKFILL_RECHECK_COOLDOWN_MS
  );
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
  return messages
    .map((message, originalIndex) => ({ message, originalIndex }))
    .sort((left, right) => {
      const leftTime = Date.parse(left.message.timestamp);
      const rightTime = Date.parse(right.message.timestamp);
      const leftSortTime = Number.isNaN(leftTime) ? Number.POSITIVE_INFINITY : leftTime;
      const rightSortTime = Number.isNaN(rightTime) ? Number.POSITIVE_INFINITY : rightTime;
      return leftSortTime - rightSortTime || left.originalIndex - right.originalIndex;
    })
    .map(({ message }, order) => ({ ...message, order }));
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
    return (
      toolResultId !== null &&
      completeHistoryToolUseIds.has(toolResultId) &&
      !existingToolResultIds.has(toolResultId)
    );
  });

  return missingToolMessages.length === 0
    ? null
    : normalizeTranscriptOrder([...existingTranscript, ...missingToolMessages]);
}
