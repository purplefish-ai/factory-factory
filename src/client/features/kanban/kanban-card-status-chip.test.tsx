import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type {
  WorkspaceStatusReason,
  WorkspaceStatusReasonTone,
} from '@/shared/workspace-status-reason';
import { KanbanStatusChip } from './kanban-card-status-chip';

function renderChip(statusReason: WorkspaceStatusReason): string {
  return renderToStaticMarkup(createElement(KanbanStatusChip, { statusReason }));
}

describe('KanbanStatusChip', () => {
  it('renames the waiting-for-CI reason to CI Running', () => {
    const markup = renderChip({
      code: 'WAITING_FOR_CI',
      label: 'Waiting for CI',
      tone: 'waiting',
      needsUser: false,
    });

    expect(markup).toContain('CI Running');
    expect(markup).not.toContain('Waiting for CI');
  });

  it.each([
    ['neutral', 'bg-muted'],
    ['working', 'bg-running/10'],
    ['waiting', 'bg-info/10'],
    ['attention', 'bg-warning/10'],
    ['success', 'bg-success/10'],
    ['danger', 'bg-destructive/10'],
  ] satisfies [WorkspaceStatusReasonTone, string][])(
    'maps the %s tone to the shared status chip treatment',
    (tone, expectedClass) => {
      const markup = renderChip({
        code: 'READY_FOR_NEXT_PROMPT',
        label: 'Ready',
        tone,
        needsUser: false,
      });

      expect(markup).toContain(expectedClass);
    }
  );
});
