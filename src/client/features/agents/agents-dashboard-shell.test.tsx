// @vitest-environment jsdom
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { expect, it, vi } from 'vitest';
import { actFlushSync } from '@/test-utils/react-act';
import { AgentsDashboardShell } from './agents-dashboard-shell';
import { eventAgentFixture, eventSummaryFixture } from './event-agent.test-support';

it('keeps the project rail visible beside task errors and links explicit selections', () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div');
  const root = createRoot(container);
  actFlushSync(() =>
    root.render(
      <MemoryRouter>
        <AgentsDashboardShell
          projectSlug="project"
          agents={[
            {
              id: 'one',
              name: 'Review code',
              prompt: 'Review recent changes',
              cadence: 'DAILY',
              isEnabled: true,
              scheduledTime: null,
              timezone: null,
              nextRunAt: new Date(),
              lastRunAt: null,
            },
          ]}
          selectedAgentId="invalid"
          onCreate={vi.fn()}
        >
          <p role="alert">Agent not found</p>
        </AgentsDashboardShell>
      </MemoryRouter>
    )
  );
  expect(container.querySelector('nav[aria-label="Agents"]')).not.toBeNull();
  expect(container.querySelector('a[href="/projects/project/agents/one"]')?.textContent).toContain(
    'Review code'
  );
  expect(container.querySelector('a[aria-current="page"]')).toBeNull();
  expect(container.textContent).toContain('Agent not found');
  expect(container.querySelector('[role=combobox]')).toBeNull();
  actFlushSync(() => root.unmount());
});

it('groups both kinds and keeps event continuation inside the event section', () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const scheduled = {
    id: 'same',
    name: 'Scheduled review',
    prompt: 'Review changes',
    cadence: 'DAILY' as const,
    isEnabled: true,
    scheduledTime: null,
    timezone: null,
    nextRunAt: new Date(),
    lastRunAt: null,
  };
  actFlushSync(() =>
    root.render(
      <MemoryRouter>
        <AgentsDashboardShell
          projectSlug="project"
          agents={[
            scheduled,
            {
              ...eventSummaryFixture(eventAgentFixture()),
              id: 'same',
              kind: 'event',
              name: 'Event review',
            },
          ]}
          selectedAgentId="same"
          selectedKind="event"
          onCreate={vi.fn()}
          continuation={<button type="button">Load more event agents</button>}
        >
          <p>Detail</p>
        </AgentsDashboardShell>
      </MemoryRouter>
    )
  );
  try {
    const scheduledSection = container.querySelector('section[aria-label="Scheduled"]');
    const eventSection = container.querySelector('section[aria-label="Event"]');
    expect(scheduledSection?.textContent).toContain('Scheduled review');
    expect(scheduledSection?.querySelector('[aria-current]')).toBeNull();
    expect(scheduledSection?.textContent).not.toContain('Load more event agents');
    expect(eventSection?.querySelector('[aria-current="page"]')?.textContent).toContain(
      'Event review'
    );
    expect(eventSection?.textContent).toContain('Load more event agents');
  } finally {
    actFlushSync(() => root.unmount());
  }
});

it('offers the same explicit creation choices after the menu closes', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const onCreate = vi.fn(() => {
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
  actFlushSync(() =>
    root.render(
      <MemoryRouter>
        <AgentsDashboardShell projectSlug="project" agents={[]} onCreate={onCreate}>
          <p>Detail</p>
        </AgentsDashboardShell>
      </MemoryRouter>
    )
  );
  try {
    const triggers = [...container.querySelectorAll('button')].filter(
      (button) => button.textContent === 'Create agent'
    );
    expect(triggers).toHaveLength(2);
    for (const [index, trigger] of triggers.entries()) {
      actFlushSync(() =>
        trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
      );
      const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
      expect(items.map((item) => item.textContent)).toEqual(['Scheduled agent', 'Event agent']);
      expect(onCreate).toHaveBeenCalledTimes(index);
      actFlushSync(() => items[index]?.click());
      await vi.waitFor(() =>
        expect(onCreate).toHaveBeenLastCalledWith(index === 0 ? 'scheduled' : 'event')
      );
    }
  } finally {
    actFlushSync(() => root.unmount());
    container.remove();
  }
});

it.each(['column', 'row'])('reveals a newly selected editor only in %s layout', (direction) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
  const scroll = vi.fn();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: scroll,
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const render = (selectedAgentId: string) =>
    actFlushSync(() =>
      root.render(
        <MemoryRouter>
          <AgentsDashboardShell
            projectSlug="project"
            selectedAgentId={selectedAgentId}
            agents={[]}
            onCreate={() => undefined}
          >
            <h2>Editor</h2>
          </AgentsDashboardShell>
        </MemoryRouter>
      )
    );
  try {
    render('one');
    const body = container.querySelector<HTMLElement>('[class~="@container/agents"] > div')!;
    body.style.flexDirection = direction;
    expect(scroll).not.toHaveBeenCalled();
    render('two');
    const editor = container.querySelector('main');
    expect(scroll.mock.calls.length).toBe(direction === 'column' ? 1 : 0);
    if (direction === 'column') {
      expect(document.activeElement).toBe(editor);
    } else {
      expect(document.activeElement).not.toBe(editor);
    }
  } finally {
    actFlushSync(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    if (original) {
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', original);
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    }
  }
});

it('waits for the loading rail before revealing route intent once, then preserves user scroll on refresh', () => {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
  const scroll = vi.fn();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: scroll,
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const render = (isLoading: boolean) =>
    actFlushSync(() =>
      root.render(
        <MemoryRouter>
          <AgentsDashboardShell
            projectSlug="project"
            selectedAgentId="one"
            revealEditorOnMount
            isLoading={isLoading}
            agents={[]}
            onCreate={() => undefined}
          >
            <h2>Editor</h2>
          </AgentsDashboardShell>
        </MemoryRouter>
      )
    );
  try {
    render(true);
    const body = container.querySelector<HTMLElement>('[class~="@container/agents"] > div')!;
    body.style.flexDirection = 'column';
    expect(scroll).not.toHaveBeenCalled();
    render(false);
    expect(scroll).toHaveBeenCalledTimes(1);
    render(true);
    render(false);
    expect(scroll).toHaveBeenCalledTimes(1);
  } finally {
    actFlushSync(() => root.unmount());
    container.remove();
    if (original) {
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', original);
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    }
  }
});
