import { describe, expect, it } from 'vitest';
import { getWorkflowPermissionPreset, isUnattendedWorkflow } from './session-workflow-permissions';

describe('workflow permissions', () => {
  it('recognizes automation workflows', () => {
    expect(isUnattendedWorkflow('periodic-task')).toBe(true);
    expect(isUnattendedWorkflow('event-agent')).toBe(true);
    expect(isUnattendedWorkflow('auto-iteration')).toBe(false);
    expect(isUnattendedWorkflow('implement')).toBe(false);
  });

  for (const workflow of ['periodic-task', 'event-agent']) {
    for (const provider of ['CODEX', 'CLAUDE'] as const) {
      it(`defaults ${workflow} ${provider} to auto review independently of workspace permissions`, () => {
        expect(getWorkflowPermissionPreset(workflow, provider)).toBe('RELAXED');
        expect(
          getWorkflowPermissionPreset(workflow, provider, { defaultWorkspacePermissions: 'YOLO' })
        ).toBe('RELAXED');
      });
      it.each(['STRICT', 'RELAXED', 'YOLO'] as const)(
        `uses explicit %s automation permissions for ${workflow} ${provider}`,
        (automationPermissions) => {
          expect(
            getWorkflowPermissionPreset(workflow, provider, {
              defaultWorkspacePermissions: 'STRICT',
              automationPermissions,
            })
          ).toBe(automationPermissions);
        }
      );
    }
  }

  it.each(['STRICT', 'RELAXED', 'YOLO'] as const)(
    'preserves workspace permissions %s for ordinary and legacy sessions',
    (defaultWorkspacePermissions) => {
      for (const workflow of ['implement', 'auto-iteration']) {
        expect(
          getWorkflowPermissionPreset(workflow, 'CODEX', {
            defaultWorkspacePermissions,
            automationPermissions: 'RELAXED',
          })
        ).toBe(defaultWorkspacePermissions);
      }
    }
  );
});
