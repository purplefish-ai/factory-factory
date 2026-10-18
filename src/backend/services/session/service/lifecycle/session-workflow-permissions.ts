import type { SessionPermissionPreset, SessionProvider } from '@prisma-gen/client';

export function isUnattendedWorkflow(workflow: string): boolean {
  return workflow === 'auto-iteration' || workflow === 'periodic-task';
}

export function getWorkflowPermissionPreset(
  workflow: string,
  provider: SessionProvider,
  settings: {
    autoIterationPermissions: SessionPermissionPreset;
    defaultWorkspacePermissions: SessionPermissionPreset;
  } = { autoIterationPermissions: 'YOLO', defaultWorkspacePermissions: 'STRICT' }
): SessionPermissionPreset {
  if (workflow === 'periodic-task' && provider === 'CODEX') {
    return 'YOLO';
  }
  return workflow === 'auto-iteration'
    ? settings.autoIterationPermissions
    : settings.defaultWorkspacePermissions;
}
