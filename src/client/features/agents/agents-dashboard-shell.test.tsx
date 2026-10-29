// @vitest-environment jsdom
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { expect, it, vi } from 'vitest';
import { actFlushSync } from '@/test-utils/react-act';
import { AgentsDashboardShell } from './agents-dashboard-shell';

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
