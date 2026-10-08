import { z } from 'zod';
import { createLogger } from '@/backend/services/logger.service';
import {
  defaultPRMonitoringServices,
  type PRMonitoringServices,
} from './pr-monitoring-dependencies';

const logger = createLogger('pr-monitoring-cutover');
export async function retireLegacyRatchetSessions(
  services: PRMonitoringServices = defaultPRMonitoringServices
): Promise<{
  retired: number;
  blockedWorkspaceIds: string[];
}> {
  const { sessionDataService, workspacePRMonitoringService } = services;
  let retired = 0;
  const blockedWorkspaceIds: string[] = [];
  for (const config of await workspacePRMonitoringService.listConfigs()) {
    const sessions = (
      await sessionDataService.findAgentSessionsByWorkspaceId(config.workspaceId)
    ).filter((s) => s.workflow === 'ratchet');
    const legacyIds = await retainedLegacyIds(config, services);
    if (!legacyIds) {
      blockedWorkspaceIds.push(config.workspaceId);
      continue;
    }
    let blocked = await missingLegacyTranscripts(
      config.workspaceId,
      legacyIds,
      sessions.map((s) => s.id),
      services
    );
    const completionRevision = await establishLegacyFence(
      config,
      sessions.length > 0 || blocked,
      services
    );
    if (completionRevision === null) {
      blockedWorkspaceIds.push(config.workspaceId);
      continue;
    }
    for (const session of sessions) {
      if (await retireSession(config.workspaceId, session.id, services)) {
        retired++;
      } else {
        blocked = true;
      }
    }
    if (blocked) {
      blockedWorkspaceIds.push(config.workspaceId);
      continue;
    }
    if (!(await completeRetirement(config.workspaceId, completionRevision, services))) {
      blockedWorkspaceIds.push(config.workspaceId);
    }
  }
  return { retired, blockedWorkspaceIds };
}

type MonitoringConfig = Awaited<
  ReturnType<PRMonitoringServices['workspacePRMonitoringService']['listConfigs']>
>[number];
async function missingLegacyTranscripts(
  workspaceId: string,
  legacyIds: string[],
  activeIds: string[],
  services: PRMonitoringServices
) {
  const missing = legacyIds.filter((id) => !activeIds.includes(id));
  if (!missing.length) {
    return false;
  }
  const transcripts = await services.sessionDataService.findClosedSessionsByWorkspaceId(
    workspaceId,
    1000
  );
  return missing.some((id) => !transcripts.some((t) => t.sessionId === id));
}
async function establishLegacyFence(
  config: MonitoringConfig,
  needed: boolean,
  services: PRMonitoringServices
) {
  if (!needed) {
    return config.bindingRevision;
  }
  const fence = await services.workspacePRMonitoringService.pauseWorkspace(
    config.workspaceId,
    'LEGACY_FIXER',
    config.bindingRevision
  );
  return fence.count ? config.bindingRevision + 1 : null;
}
async function completeRetirement(
  workspaceId: string,
  bindingRevision: number,
  services: PRMonitoringServices
) {
  const completed = await services.workspacePRMonitoringService.completeLegacyRetirement(
    workspaceId,
    bindingRevision
  );
  if (completed?.count !== 0) {
    return true;
  }
  // Cleanup is already confirmed. Clear only the legacy portion of a newer fence,
  // preserving a stop/failure that arrived while transcript retention ran.
  const current = await services.workspacePRMonitoringService.get(workspaceId);
  if (!current?.deliveryPauseReason?.startsWith('LEGACY_FIXER')) {
    return true;
  }
  const retry = await services.workspacePRMonitoringService.completeLegacyRetirement(
    workspaceId,
    current.bindingRevision
  );
  return retry.count > 0;
}
async function retainedLegacyIds(
  config: Awaited<
    ReturnType<PRMonitoringServices['workspacePRMonitoringService']['listConfigs']>
  >[number],
  services: PRMonitoringServices
) {
  const parsed = z.array(z.string()).safeParse(config.legacySessionIds ?? []);
  if (parsed.success) {
    return parsed.data;
  }
  await services.workspacePRMonitoringService.pauseWorkspace(
    config.workspaceId,
    'LEGACY_FIXER',
    config.bindingRevision
  );
  logger.warn('Invalid legacy retention metadata', {
    workspaceId: config.workspaceId,
    error: parsed.error,
  });
  return null;
}
async function retireSession(
  workspaceId: string,
  sessionId: string,
  services: PRMonitoringServices
) {
  const { sessionLifecycleService, sessionDataService } = services;
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
