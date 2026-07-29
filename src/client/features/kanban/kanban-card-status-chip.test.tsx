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
    ['working', 'bg-brand/15'],
    ['waiting', 'bg-yellow-500/15'],
    ['attention', 'bg-amber-500/15'],
    ['success', 'bg-emerald-500/15'],
    ['danger', 'bg-red-500/15'],
  ] satisfies [
    WorkspaceStatusReasonTone,
    string,
  ][])('maps the %s tone to its card chip treatment', (tone, expectedClass) => {
    const markup = renderChip({
      code: 'READY_FOR_NEXT_PROMPT',
      label: 'Ready',
      tone,
      needsUser: false,
    });

    expect(markup).toContain(expectedClass);
  });
});
