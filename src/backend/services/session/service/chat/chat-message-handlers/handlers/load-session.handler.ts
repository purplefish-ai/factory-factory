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
import {
  sessionConfigService,
  sessionLifecycleEventService,
  sessionLifecycleService,
} from '@/backend/services/session/service/lifecycle/session-core-services';
import { hydrateProviderHistoryIfNeeded } from '@/backend/services/session/service/lifecycle/session-provider-history-hydrator';
import { sessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { finalizeInterruptedTranscriptToolCalls } from '@/backend/services/session/service/store/session-tool-call-recovery';
import { slashCommandCacheService } from '@/backend/services/session/service/store/slash-command-cache.service';
import {
  commandNameKey,
  scanClaudeGlobalCommandsFromDisk,
  scanClaudeWorkspaceCommandsFromDisk,
} from '@/backend/services/session/service/store/slash-command-disk-scanner';
import type { CommandInfo } from '@/shared/acp-protocol';
import type { LoadSessionMessage } from '@/shared/websocket';

const logger = createLogger('load-session-handler');

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
    await sessionLifecycleEventService.hydrate(sessionId);

    const sessionRuntime = sessionLifecycleService.getRuntimeSnapshot(sessionId);
    if (sessionRuntime.processState === 'stopped') {
      const transcript = sessionDomainService.getTranscriptSnapshot(sessionId);
      const recoveredTranscript = finalizeInterruptedTranscriptToolCalls(
        transcript,
        sessionRuntime.updatedAt
      );
      if (recoveredTranscript !== transcript) {
        sessionDomainService.replaceTranscript(sessionId, recoveredTranscript);
      }
    }
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

    const chatCapabilities = await sessionConfigService.getChatBarCapabilities(sessionId);
    sessionDomainService.emitDelta(sessionId, {
      type: 'chat_capabilities',
      capabilities: chatCapabilities,
    });
    const configOptions = await sessionConfigService.getSessionConfigOptionsWithFallback(sessionId);
    if (configOptions.length > 0) {
      sessionDomainService.emitDelta(sessionId, {
        type: 'config_options_update',
        configOptions,
      });
    }

    await sendCachedSlashCommandsIfNeeded(
      sessionId,
      dbSession.provider,
      dbSession.workspace.worktreePath
    );

    // Auto-enqueue initial message if one was stored during session creation
    await enqueueInitialMessageIfPresent(sessionId, deps);
  };
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
  provider: 'CLAUDE' | 'CODEX',
  worktreePath: string | null
): Promise<void> {
  const cached = await slashCommandCacheService.getCachedCommands(provider);
  const commands =
    provider === 'CLAUDE' ? buildClaudeSlashCommandsForLoad(cached, worktreePath) : (cached ?? []);

  const slashCommandsMsg = {
    type: 'slash_commands',
    slashCommands: commands,
  } as const;
  sessionDomainService.emitDelta(sessionId, slashCommandsMsg);
}

function buildClaudeSlashCommandsForLoad(
  cached: CommandInfo[] | null,
  worktreePath: string | null
): CommandInfo[] {
  const seen = new Set<string>();
  const commands = scanClaudeWorkspaceCommandsFromDisk(worktreePath, seen);
  if (cached) {
    for (const command of cached) {
      const key = commandNameKey(command.name);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      commands.push(command);
    }
    return commands;
  }

  commands.push(...scanClaudeGlobalCommandsFromDisk(seen));
  return commands;
}
