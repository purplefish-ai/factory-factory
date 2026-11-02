import { createLogger } from '@/backend/services/logger.service';
import { userSettingsService } from '@/backend/services/settings';
import type { SessionPermissionPreset, SessionProvider } from '@prisma-gen/client';
import { getWorkflowPermissionPreset } from './session-workflow-permissions';
const logger = createLogger('session');
export async function resolvePermissionPresetFromSettings(
  sessionId: string,
  workflow: string,
  provider: SessionProvider
): Promise<SessionPermissionPreset> {
  const fallback: SessionPermissionPreset = getWorkflowPermissionPreset(workflow, provider);
  try {
    const settings = await userSettingsService.get();
    return getWorkflowPermissionPreset(workflow, provider, settings);
  } catch (error) {
    logger.warn('Failed loading user permission presets; using defaults', {
      sessionId,
      workflow,
      error: error instanceof Error ? error.message : String(error),
    });
    return fallback;
  }
}
