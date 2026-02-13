import type { ChatMessageHandler } from '@/backend/domains/session/chat/chat-message-handlers/types';
import { SessionManager } from '@/backend/domains/session/claude/session';
import { sessionService } from '@/backend/domains/session/lifecycle/session.service';
import { sessionDomainService } from '@/backend/domains/session/session-domain.service';
import { slashCommandCacheService } from '@/backend/domains/session/store/slash-command-cache.service';
import { agentSessionAccessor } from '@/backend/resource_accessors/agent-session.accessor';
import type { LoadSessionMessage } from '@/shared/websocket';

export function createLoadSessionHandler(): ChatMessageHandler<LoadSessionMessage> {
  return async ({ ws, sessionId, message }) => {
    const dbSession = await agentSessionAccessor.findById(sessionId);
    if (!dbSession) {
      ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
      return;
    }

    const shouldUseClaudeSessionFiles = dbSession.provider === 'CLAUDE';
    const workspaceProjectPath =
      shouldUseClaudeSessionFiles && dbSession.workspace.worktreePath
        ? SessionManager.getProjectPath(dbSession.workspace.worktreePath)
        : null;
    let claudeProjectPath = shouldUseClaudeSessionFiles
      ? (dbSession.claudeProjectPath ?? workspaceProjectPath)
      : null;
    if (
      shouldUseClaudeSessionFiles &&
      dbSession.claudeSessionId &&
      dbSession.claudeProjectPath &&
      workspaceProjectPath &&
      dbSession.claudeProjectPath !== workspaceProjectPath &&
      !SessionManager.hasSessionFileFromProjectPath(
        dbSession.claudeSessionId,
        dbSession.claudeProjectPath
      ) &&
      SessionManager.hasSessionFileFromProjectPath(dbSession.claudeSessionId, workspaceProjectPath)
    ) {
      // Persisted path can become stale after worktree moves; prefer live workspace path when it
      // clearly contains the session file.
      claudeProjectPath = workspaceProjectPath;
    }

    const sessionRuntime = sessionService.getRuntimeSnapshot(sessionId);
    await sessionDomainService.subscribe({
      sessionId,
      claudeProjectPath,
      claudeSessionId: shouldUseClaudeSessionFiles ? dbSession.claudeSessionId : null,
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
