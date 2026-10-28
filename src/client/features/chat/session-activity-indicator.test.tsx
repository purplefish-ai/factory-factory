// @vitest-environment jsdom
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SessionActivityIndicator } from './session-activity-indicator';

describe('SessionActivityIndicator', () => {
  it.each([1, 2])('opens Agents from the %s running sub-agent label', (runningSubagents) => {
    const onOpenAgents = vi.fn();
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      flushSync(() =>
        root.render(
          <SessionActivityIndicator
            work={{ promptInFlight: false, backgroundTasks: [], runningSubagents, activeGoals: 0 }}
            onOpenAgents={onOpenAgents}
          />
        )
      );
      const button = container.querySelector('button');
      expect(button?.textContent).toContain(`${runningSubagents} sub-agent`);
      button?.click();
      expect(onOpenAgents).toHaveBeenCalledOnce();
    } finally {
      flushSync(() => root.unmount());
    }
  });

  it.each([
    [1, '1 goal active'],
    [2, '2 goals active'],
  ] as const)('shows the count for %s active goals', (activeGoals, label) => {
    const markup = renderToStaticMarkup(
      <SessionActivityIndicator
        work={{ promptInFlight: false, backgroundTasks: [], runningSubagents: 0, activeGoals }}
      />
    );
    expect(markup).toContain(label);
  });

  it('keeps an agent spinner for autonomous Claude turns after the prompt RPC ends', () => {
    const markup = renderToStaticMarkup(
      <SessionActivityIndicator
        work={{
          promptInFlight: false,
          backgroundTasks: [{ id: 'turn', name: 'Claude is working', kind: 'turn' }],
          runningSubagents: 0,
          activeGoals: 0,
        }}
      />
    );
    expect(markup).toContain('animate-spin');
    expect(markup).toContain('Agent is working');
    expect(markup).not.toContain('Background process');
    expect(markup).not.toContain('Background activity');
  });
});
