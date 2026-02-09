import { sessionDomainService } from '@/backend/domains/session/session-domain.service';
import type { LoadSessionMessage } from '@/shared/websocket';
import { SessionManager } from '../../../claude/session';
import { claudeSessionAccessor } from '../../../resource_accessors/claude-session.accessor';
import { sessionService } from '../../session.service';
import { slashCommandCacheService } from '../../slash-command-cache.service';
import type { ChatMessageHandler } from '../types';

export function createLoadSessionHandler(): ChatMessageHandler<LoadSessionMessage> {
  return async ({ ws, sessionId, message }) => {
    const dbSession = await claudeSessionAccessor.findById(sessionId);
    if (!dbSession) {
      ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
      return;
    }

    const workspaceProjectPath = dbSession.workspace.worktreePath
      ? SessionManager.getProjectPath(dbSession.workspace.worktreePath)
      : null;
    let claudeProjectPath = dbSession.claudeProjectPath ?? workspaceProjectPath;
    if (
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
      claudeSessionId: dbSession.claudeSessionId,
      sessionRuntime,
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
  sessionDomainService.emitDelta(sessionId, slashCommandsMsg);
}
