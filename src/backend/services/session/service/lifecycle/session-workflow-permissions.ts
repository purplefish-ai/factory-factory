import type { SessionPermissionPreset, SessionProvider } from '@prisma-gen/client';

export function isUnattendedWorkflow(workflow: string): boolean {
  return workflow === 'periodic-task';
}

export function getWorkflowPermissionPreset(
  workflow: string,
  provider: SessionProvider,
  settings: {
    defaultWorkspacePermissions: SessionPermissionPreset;
  } = { defaultWorkspacePermissions: 'STRICT' }
): SessionPermissionPreset {
  if (workflow === 'periodic-task' && provider === 'CODEX') {
    return 'YOLO';
  }
  return settings.defaultWorkspacePermissions;
}
