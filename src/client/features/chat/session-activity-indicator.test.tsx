// @vitest-environment jsdom
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SubagentIcon } from '@/client/components/subagent-icon';
import { SessionActivityIndicator } from './session-activity-indicator';

describe('SessionActivityIndicator', () => {
  it('announces process counts without including the disclosure control or commands', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const render = (backgroundTasks: { id: string; name: string; kind: 'shell' }[]) => {
      flushSync(() =>
        root.render(
          <SessionActivityIndicator
            work={{ promptInFlight: false, backgroundTasks, runningSubagents: 0, activeGoals: 0 }}
          />
        )
      );
    };
    try {
      render([{ id: 'preview', name: 'pnpm storybook', kind: 'shell' }]);
      const trigger = container.querySelector<HTMLButtonElement>('button[aria-expanded]');
      expect(trigger).not.toBeNull();
      expect(trigger?.closest('[role="status"], [aria-live]')).toBeNull();
      expect(container.querySelector('[role="status"]')?.textContent).toBe(
        'Background process running'
      );
      flushSync(() => trigger?.click());
      const command = container.querySelector('li');
      expect(command?.textContent).toBe('pnpm storybook');
      expect(command?.closest('[role="status"], [aria-live]')).toBeNull();
      render([
        { id: 'preview', name: 'pnpm storybook', kind: 'shell' },
        { id: 'tests', name: 'pnpm test', kind: 'shell' },
      ]);
      expect(container.querySelector('[role="status"]')?.textContent).toBe(
        '2 background processes running'
      );
      expect(trigger?.getAttribute('aria-expanded')).toBe('true');
    } finally {
      root.unmount();
    }
  });

  it.each([
    [1, '1 sub-agent running'],
    [2, '2 sub-agents running'],
  ] as const)('opens Agents from the %s running sub-agent label', (runningSubagents, label) => {
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
      expect(button?.textContent).toBe(label);
      expect(button?.closest('[role="status"], [aria-live]')).toBeNull();
      expect(container.querySelector('[role="status"]')?.textContent).toBe(label);
      button?.click();
      expect(button?.title).toBe('Open Sessions panel');
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

it('removes the inline thinking slot while retaining background controls', () => {
  const work = { promptInFlight: true, backgroundTasks: [], runningSubagents: 0, activeGoals: 0 };
  expect(renderToStaticMarkup(<SessionActivityIndicator work={work} showThinking={false} />)).toBe(
    ''
  );
  const markup = renderToStaticMarkup(
    <SessionActivityIndicator work={{ ...work, runningSubagents: 2 }} showThinking={false} />
  );
  expect(markup).toContain('2 sub-agents running');
  expect(markup).not.toContain('Agent is working');
});

it('uses the running agents assigned icons rather than restarting the icon sequence', () => {
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(
    <SessionActivityIndicator
      work={{ promptInFlight: false, backgroundTasks: [], runningSubagents: 2, activeGoals: 0 }}
      runningSubagentIconIndices={[3, 12]}
    />
  );
  const icons = container.querySelector('button > span[aria-hidden="true"]');
  expect(icons?.innerHTML).toBe(
    renderToStaticMarkup(
      <>
        <SubagentIcon index={3} />
        <SubagentIcon index={12} />
      </>
    )
  );
});

it('does not invent agent icons while summaries are unavailable', () => {
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(
    <SessionActivityIndicator
      work={{ promptInFlight: false, backgroundTasks: [], runningSubagents: 2, activeGoals: 0 }}
    />
  );
  expect(container.querySelector('button > span[aria-hidden="true"]')?.children.length ?? 0).toBe(
    0
  );
  expect(container.textContent).toContain('2 sub-agents running');
});
