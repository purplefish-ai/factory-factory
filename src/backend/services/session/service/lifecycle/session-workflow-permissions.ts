import type { SessionPermissionPreset } from '@prisma-gen/client';

export function isUnattendedWorkflow(workflow: string): boolean {
  return workflow === 'ratchet' || workflow === 'auto-iteration';
}

export function getWorkflowPermissionPreset(
  workflow: string,
  settings: {
    ratchetPermissions: SessionPermissionPreset;
    defaultWorkspacePermissions: SessionPermissionPreset;
  } = { ratchetPermissions: 'YOLO', defaultWorkspacePermissions: 'STRICT' }
): SessionPermissionPreset {
  return isUnattendedWorkflow(workflow)
    ? settings.ratchetPermissions
    : settings.defaultWorkspacePermissions;
}
