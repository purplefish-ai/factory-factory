// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SessionActivityIndicator } from './session-activity-indicator';

describe('SessionActivityIndicator', () => {
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
