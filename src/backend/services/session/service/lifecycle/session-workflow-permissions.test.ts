import { describe, expect, it } from 'vitest';
import { getWorkflowPermissionPreset, isUnattendedWorkflow } from './session-workflow-permissions';

describe('workflow permissions', () => {
  it('recognizes scheduled sessions while legacy sessions use ordinary controls', () => {
    expect(isUnattendedWorkflow('periodic-task')).toBe(true);
    expect(isUnattendedWorkflow('event-agent')).toBe(true);
    expect(isUnattendedWorkflow('auto-iteration')).toBe(false);
    expect(isUnattendedWorkflow('implement')).toBe(false);
  });

  it.each(['STRICT', 'RELAXED', 'YOLO'] as const)(
    'uses workspace permissions %s for legacy sessions while preserving periodic-task policy',
    (defaultWorkspacePermissions) => {
      const settings = { defaultWorkspacePermissions };
      expect(getWorkflowPermissionPreset('periodic-task', 'CODEX', settings)).toBe('YOLO');
      expect(getWorkflowPermissionPreset('periodic-task', 'CLAUDE', settings)).toBe(
        defaultWorkspacePermissions
      );
      expect(getWorkflowPermissionPreset('event-agent', 'CODEX', settings)).toBe(
        defaultWorkspacePermissions
      );
      expect(getWorkflowPermissionPreset('event-agent', 'CLAUDE', settings)).toBe(
        defaultWorkspacePermissions
      );
      expect(getWorkflowPermissionPreset('implement', 'CODEX', settings)).toBe(
        defaultWorkspacePermissions
      );
      expect(getWorkflowPermissionPreset('auto-iteration', 'CODEX', settings)).toBe(
        defaultWorkspacePermissions
      );
    }
  );
});
