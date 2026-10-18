import { describe, expect, it } from 'vitest';
import { getWorkflowPermissionPreset, isUnattendedWorkflow } from './session-workflow-permissions';

describe('unattended workflows', () => {
  it('recognizes scheduled sessions without changing ordinary implementation sessions', () => {
    expect(isUnattendedWorkflow('periodic-task')).toBe(true);
    expect(isUnattendedWorkflow('auto-iteration')).toBe(true);
    expect(isUnattendedWorkflow('implement')).toBe(false);
  });

  it.each(['STRICT', 'YOLO'] as const)(
    'keeps scheduled permissions independent of %s auto-iteration permissions',
    (autoIterationPermissions) => {
      const settings = {
        autoIterationPermissions,
        defaultWorkspacePermissions: 'STRICT',
      } as const;
      expect(getWorkflowPermissionPreset('periodic-task', 'CODEX', settings)).toBe('YOLO');
      expect(getWorkflowPermissionPreset('periodic-task', 'CLAUDE', settings)).toBe('STRICT');
      expect(getWorkflowPermissionPreset('implement', 'CODEX', settings)).toBe('STRICT');
      expect(getWorkflowPermissionPreset('auto-iteration', 'CODEX', settings)).toBe(
        autoIterationPermissions
      );
    }
  );
});
