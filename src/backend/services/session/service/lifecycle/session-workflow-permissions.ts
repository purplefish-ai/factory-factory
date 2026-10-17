import type { SessionPermissionPreset } from '@prisma-gen/client';

export function isUnattendedWorkflow(workflow: string): boolean {
  return workflow === 'auto-iteration' || workflow === 'periodic-task';
}

export function getWorkflowPermissionPreset(
  workflow: string,
  settings: {
    autoIterationPermissions: SessionPermissionPreset;
    defaultWorkspacePermissions: SessionPermissionPreset;
  } = { autoIterationPermissions: 'YOLO', defaultWorkspacePermissions: 'STRICT' }
): SessionPermissionPreset {
  if (workflow === 'periodic-task') {
    return 'YOLO';
  }
  return workflow === 'auto-iteration'
    ? settings.autoIterationPermissions
    : settings.defaultWorkspacePermissions;
}
