import type { ChatMessageHandler } from '@/backend/domains/session/chat/chat-message-handlers/types';
import { sessionService } from '@/backend/domains/session/lifecycle/session.service';
import { sessionDomainService } from '@/backend/domains/session/session-domain.service';
import { slashCommandCacheService } from '@/backend/domains/session/store/slash-command-cache.service';
import { agentSessionAccessor } from '@/backend/resource_accessors/agent-session.accessor';
import type { LoadSessionMessage } from '@/shared/websocket';

type PersistedSession = NonNullable<Awaited<ReturnType<typeof agentSessionAccessor.findById>>>;

function resolveClaudeHydrationContext(session: PersistedSession): {
  claudeProjectPath: string | null;
  claudeSessionId: string | null;
} {
  if (session.provider !== 'CLAUDE') {
    return {
      claudeProjectPath: null,
      claudeSessionId: null,
    };
  }

  return {
    claudeProjectPath: session.claudeProjectPath ?? null,
    claudeSessionId: session.claudeSessionId ?? null,
  };
}

export function createLoadSessionHandler(): ChatMessageHandler<LoadSessionMessage> {
  return async ({ ws, sessionId, message }) => {
    const dbSession = await agentSessionAccessor.findById(sessionId);
    if (!dbSession) {
      ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
      return;
    }

    const { claudeProjectPath, claudeSessionId } = resolveClaudeHydrationContext(dbSession);
    const sessionRuntime = sessionService.getRuntimeSnapshot(sessionId);
    await sessionDomainService.subscribe({
      sessionId,
      claudeProjectPath,
      claudeSessionId,
      sessionRuntime,
      loadRequestId: message.loadRequestId,
    });

    const chatCapabilities = await sessionService.getChatBarCapabilities(sessionId);
    sessionDomainService.emitDelta(sessionId, {
      type: 'chat_capabilities',
      capabilities: chatCapabilities,
    });

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
