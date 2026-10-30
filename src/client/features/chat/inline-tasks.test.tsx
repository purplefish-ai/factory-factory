// @vitest-environment jsdom
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import type { AcpPlanState } from './reducer';
import { createActionFromWebSocketMessage } from './reducer';
import { TranscriptTail } from './transcript-layout';

describe('inline tasks', () => {
  it('shows shared ACP tasks while idle, updates them, and hides them during hydration', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const render = (acpPlan: AcpPlanState | null, loadingSession = false, isCompacting = false) =>
      flushSync(() =>
        root.render(
          <TranscriptTail
            hasVisibleMessages={false}
            props={{
              messages: [],
              acpPlan,
              running: false,
              startingSession: false,
              loadingSession,
              isCompacting,
            }}
          />
        )
      );
    const plan: AcpPlanState = {
      entries: [
        { content: 'Read the code', status: 'completed', priority: 'medium' },
        { content: 'Implement tasks', status: 'in_progress', priority: 'high' },
        { content: 'Ship changes', status: 'pending', priority: 'low' },
      ],
      updatedAt: '2026-10-30T00:00:00Z',
    };
    try {
      render(plan, false, true);
      expect(container.querySelector('[aria-label="Tasks"]')?.textContent).toContain(
        'Read the code'
      );
      expect(container.querySelector('[aria-label="Tasks"]')?.textContent).toContain(
        'Implement tasks'
      );
      expect(container.querySelectorAll('[aria-label="Completed"]')).toHaveLength(1);
      expect(container.querySelectorAll('[aria-label="In progress"]')).toHaveLength(1);
      expect(container.textContent).not.toContain('Ready to start');
      expect(container.textContent?.indexOf('Implement tasks')).toBeLessThan(
        container.textContent?.indexOf('Compacting context...') ?? -1
      );
      render({
        ...plan,
        entries: plan.entries.map((entry) => ({ ...entry, status: 'completed' })),
      });
      expect(container.querySelectorAll('[aria-label="Completed"]')).toHaveLength(3);
      expect(container.querySelectorAll('[aria-label="In progress"]')).toHaveLength(0);
      render(plan, true);
      expect(container.querySelector('[aria-label="Tasks"]')).toBeNull();
      render({ ...plan, entries: [] });
      expect(container.querySelector('[aria-label="Tasks"]')).toBeNull();
      render(null);
      expect(container.textContent).toContain('Ready to start');
    } finally {
      flushSync(() => root.unmount());
    }
  });

  it('validates ACP plan notification entries before rendering them', () => {
    const action = createActionFromWebSocketMessage({
      type: 'task_notification',
      message: JSON.stringify({
        type: 'acp_plan',
        entries: [{ content: {}, status: 'completed' }],
      }),
    });
    expect(action?.type).not.toBe('ACP_PLAN_UPDATE');
  });
});
