import type { ChatMessageHandler } from '@/backend/domains/session/chat/chat-message-handlers/types';
import { sessionService } from '@/backend/domains/session/lifecycle/session.service';
import { sessionDomainService } from '@/backend/domains/session/session-domain.service';
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

    const sessionRuntime = sessionService.getRuntimeSnapshot(sessionId);
    await sessionDomainService.subscribe({
      sessionId,
      sessionRuntime,
      loadRequestId: message.loadRequestId,
    });

    const shouldEagerInit =
      Boolean(dbSession.workspace.worktreePath) &&
      (dbSession.status === 'RUNNING' || sessionRuntime.processState === 'alive');

    if (shouldEagerInit) {
      try {
        // Active runtime sessions should have live provider state negotiated
        // immediately so model/mode capabilities are accurate in the chat bar.
        await sessionService.getOrCreateSessionClientFromRecord(dbSession);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        ws.send(
          JSON.stringify({ type: 'error', message: `Failed to initialize session: ${detail}` })
        );
      }
    } else {
      logger.debug('Skipping eager ACP runtime init for inactive session', {
        sessionId,
        status: dbSession.status,
        processState: sessionRuntime.processState,
        hasWorktreePath: Boolean(dbSession.workspace.worktreePath),
      });
    }

    const chatCapabilities = await sessionService.getChatBarCapabilities(sessionId);
    sessionDomainService.emitDelta(sessionId, {
      type: 'chat_capabilities',
      capabilities: chatCapabilities,
    });
    const configOptions = sessionService.getSessionConfigOptions(sessionId);
    if (configOptions.length > 0) {
      sessionDomainService.emitDelta(sessionId, {
        type: 'config_options_update',
        configOptions,
      });
    }

    await sendCachedSlashCommandsIfNeeded(sessionId, dbSession.provider);
  };
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
