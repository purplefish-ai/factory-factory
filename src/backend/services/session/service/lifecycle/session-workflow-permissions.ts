import type { SessionPermissionPreset } from '@prisma-gen/client';

export function isUnattendedWorkflow(workflow: string): boolean {
  return workflow === 'auto-iteration';
}

export function getWorkflowPermissionPreset(
  workflow: string,
  settings: {
    autoIterationPermissions: SessionPermissionPreset;
    defaultWorkspacePermissions: SessionPermissionPreset;
  } = { autoIterationPermissions: 'YOLO', defaultWorkspacePermissions: 'STRICT' }
): SessionPermissionPreset {
  return isUnattendedWorkflow(workflow)
    ? settings.autoIterationPermissions
    : settings.defaultWorkspacePermissions;
}
