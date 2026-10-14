import { defaultPRMonitoringServices } from './pr-monitoring-dependencies';
import type { PRRecipientReadinessPorts } from './pr-monitoring-ports';
export async function recipientCanDispatch(
  workspaceId: string,
  sessionId: string,
  services: PRRecipientReadinessPorts = defaultPRMonitoringServices
): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const sessions = await Promise.race([
      services.sessionDataService.findAgentSessionsByWorkspaceId(workspaceId),
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), 5000);
      }),
    ]);
    return (
      !!sessions &&
      !sessions.some((s) => s.id !== sessionId && services.acpRuntimeManager.isSessionWorking(s.id))
    );
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
