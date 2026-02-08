import type { LoadSessionMessage } from '@/shared/websocket';
import { SessionManager } from '../../../claude/session';
import { claudeSessionAccessor } from '../../../resource_accessors/claude-session.accessor';
import { sessionService } from '../../session.service';
import { sessionStoreService } from '../../session-store.service';
import { slashCommandCacheService } from '../../slash-command-cache.service';
import type { ChatMessageHandler } from '../types';

export function createLoadSessionHandler(): ChatMessageHandler<LoadSessionMessage> {
  return async ({ ws, sessionId, message }) => {
    const dbSession = await claudeSessionAccessor.findById(sessionId);
    if (!dbSession) {
      ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
      return;
    }

    const claudeProjectPath =
      dbSession.claudeProjectPath ??
      (dbSession.workspace.worktreePath
        ? SessionManager.getProjectPath(dbSession.workspace.worktreePath)
        : null);

    const existingClient = sessionService.getClient(sessionId);
    await sessionStoreService.subscribe({
      sessionId,
      claudeProjectPath,
      claudeSessionId: dbSession.claudeSessionId,
      isRunning: existingClient?.isRunning() ?? false,
      isWorking: existingClient?.isWorking() ?? false,
      loadRequestId: message.loadRequestId,
    });

    await sendCachedSlashCommandsIfNeeded(sessionId);
  };
}

async function sendCachedSlashCommandsIfNeeded(sessionId: string): Promise<void> {
  const cached = await slashCommandCacheService.getCachedCommands();
  if (!cached || cached.length === 0) {
    return;
  }

  const slashCommandsMsg = {
    type: 'slash_commands',
    slashCommands: cached,
  } as const;
  sessionStoreService.emitDelta(sessionId, slashCommandsMsg);
}
