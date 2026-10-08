import { z } from 'zod';
import { createLogger } from '@/backend/services/logger.service';
import { sessionDataService, sessionLifecycleService } from '@/backend/services/session';
import { workspacePRMonitoringService } from '@/backend/services/workspace';

const logger = createLogger('pr-monitoring-cutover');
export async function retireLegacyRatchetSessions(): Promise<{
  retired: number;
  blockedWorkspaceIds: string[];
}> {
  let retired = 0;
  const blockedWorkspaceIds: string[] = [];
  for (const config of await workspacePRMonitoringService.listConfigs()) {
    const sessions = (
      await sessionDataService.findAgentSessionsByWorkspaceId(config.workspaceId)
    ).filter((s) => s.workflow === 'ratchet');
    const legacyIds = z.array(z.string()).parse(config.legacySessionIds ?? []);
    let blocked = false;
    const activeIds = new Set(sessions.map((s) => s.id));
    const missing = legacyIds.filter((id) => !activeIds.has(id));
    if (missing.length) {
      const transcripts = await sessionDataService.findClosedSessionsByWorkspaceId(
        config.workspaceId,
        1000
      );
      blocked = missing.some((id) => !transcripts.some((t) => t.sessionId === id));
    }
    if (sessions.length) {
      await workspacePRMonitoringService.pauseWorkspace(
        config.workspaceId,
        'LEGACY_FIXER',
        config.bindingRevision
      );
    }
    for (const session of sessions) {
      if (await retireSession(config.workspaceId, session.id)) {
        retired++;
      } else {
        blocked = true;
      }
    }
    if (blocked) {
      blockedWorkspaceIds.push(config.workspaceId);
    } else {
      await workspacePRMonitoringService.completeLegacyRetirement(config.workspaceId);
    }
  }
  return { retired, blockedWorkspaceIds };
}

async function retireSession(workspaceId: string, sessionId: string) {
  try {
    await sessionLifecycleService.stopSession(sessionId, {
      reason: 'SYSTEM_STOP',
      cleanupTransientRatchetSession: true,
    });
    const stillExists = await sessionDataService.findAgentSessionById(sessionId);
    const transcripts = await sessionDataService.findClosedSessionsByWorkspaceId(workspaceId, 100);
    if (stillExists || !transcripts.some((t) => t.sessionId === sessionId)) {
      throw new Error('Legacy fixer transcript retention is not confirmed');
    }
    return true;
  } catch (error) {
    logger.warn('Legacy fixer retirement requires recovery', {
      workspaceId: workspaceId,
      sessionId: sessionId,
      error,
    });
  }
  return false;
}
