import type { ChatMessageHandler } from '@/backend/domains/session/chat/chat-message-handlers/types';
import { claudeSessionHistoryLoaderService } from '@/backend/domains/session/data/claude-session-history-loader.service';
import { sessionService } from '@/backend/domains/session/lifecycle/session.service';
import { sessionDomainService } from '@/backend/domains/session/session-domain.service';
import { buildTranscriptFromHistory } from '@/backend/domains/session/store/session-transcript';
import { slashCommandCacheService } from '@/backend/domains/session/store/slash-command-cache.service';
import { agentSessionAccessor } from '@/backend/resource_accessors/agent-session.accessor';
import { createLogger } from '@/backend/services/logger.service';
import type { LoadSessionMessage } from '@/shared/websocket';

const logger = createLogger('load-session-handler');

export function createLoadSessionHandler(): ChatMessageHandler<LoadSessionMessage> {
  return async ({ ws, sessionId, message }) => {
    const dbSession = await agentSessionAccessor.findById(sessionId);
    if (!dbSession) {
      ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
      return;
    }

    await hydrateClaudeHistoryIfNeeded(sessionId, dbSession);

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
      isWorkspaceArchived: dbSession.workspace.status === 'ARCHIVED',
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
  };
}

async function hydrateClaudeHistoryIfNeeded(
  sessionId: string,
  dbSession: NonNullable<Awaited<ReturnType<typeof agentSessionAccessor.findById>>>
): Promise<void> {
  if (dbSession.provider !== 'CLAUDE') {
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
    sessionDomainService.markHistoryHydrated(sessionId, 'none');
    return;
  }

  const loadStart = Date.now();
  const loadResult = await claudeSessionHistoryLoaderService.loadSessionHistory({
    providerSessionId: dbSession.providerSessionId,
    workingDir: dbSession.workspace.worktreePath ?? '',
  });

  if (loadResult.status === 'loaded') {
    const transcript = buildTranscriptFromHistory(loadResult.history);
    sessionDomainService.replaceTranscript(sessionId, transcript, { historySource: 'jsonl' });
    logger.debug('Hydrated Claude transcript from JSONL history', {
      sessionId,
      providerSessionId: dbSession.providerSessionId,
      filePath: loadResult.filePath,
      historyCount: loadResult.history.length,
      transcriptCount: transcript.length,
      loadDurationMs: Date.now() - loadStart,
    });
    return;
  }

  sessionDomainService.markHistoryHydrated(sessionId, 'none');
  logger.debug('Claude JSONL history not available; skipping runtime fallback hydration', {
    sessionId,
    providerSessionId: dbSession.providerSessionId,
    loadStatus: loadResult.status,
  });
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
