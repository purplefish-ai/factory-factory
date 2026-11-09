import type { SessionPermissionPreset, SessionProvider } from '@prisma-gen/client';

export function isUnattendedWorkflow(workflow: string): boolean {
  return workflow === 'periodic-task' || workflow === 'event-agent';
}

export function getWorkflowPermissionPreset(
  workflow: string,
  _provider: SessionProvider,
  settings: {
    defaultWorkspacePermissions: SessionPermissionPreset;
    automationPermissions?: SessionPermissionPreset;
  } = { defaultWorkspacePermissions: 'STRICT' }
): SessionPermissionPreset {
  if (isUnattendedWorkflow(workflow)) {
    return settings.automationPermissions ?? 'RELAXED';
  }
  return settings.defaultWorkspacePermissions;
}
