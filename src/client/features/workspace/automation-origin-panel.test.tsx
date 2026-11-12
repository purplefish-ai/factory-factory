// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStoryTrpcClient } from '@/client/lib/storybook-trpc';
import { trpc } from '@/client/lib/trpc';
import { waitForCheck } from '@/test-utils/react-act';
import { AutomationOriginPanel } from './automation-origin-panel';
import { automationOriginFixture } from './automation-origin-panel.story-fixtures';

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let originFailure: string | null;
let requests: Array<{ path: string; input: unknown }>;

function render() {
  const fixture = automationOriginFixture();
  const client = createStoryTrpcClient({
    onRequest: (path, input) => requests.push({ path, input }),
    handlers: {
      'automation.workspaceOrigin': () => {
        if (originFailure) {
          throw new Error(originFailure);
        }
        return fixture.origin;
      },
      'automation.get': () => fixture.agent,
      'project.getById': () => fixture.project,
    },
  });
  act(() =>
    root.render(
      <trpc.Provider client={client} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <AutomationOriginPanel workspaceId="workspace-pr" projectId="owner" />
          </MemoryRouter>
        </QueryClientProvider>
      </trpc.Provider>
    )
  );
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  originFailure = null;
  requests = [];
});

afterEach(() => {
  act(() => root.unmount());
  queryClient.clear();
  container.remove();
  vi.unstubAllGlobals();
});

describe('AutomationOriginPanel', () => {
  it('shows the automation and the run that started this workspace, linking to the automation', async () => {
    render();
    await waitForCheck(() => expect(container.textContent).toContain('Investigate labeled issues'));
    expect(container.textContent).toContain('Event-triggered');
    expect(container.textContent).toContain('PR created');
    expect(
      container.querySelector('a[href="https://github.com/example/repo/pull/42"]')
    ).not.toBeNull();
    const manage = [...container.querySelectorAll('a')].find(
      (link) => link.textContent === 'Manage automation'
    );
    expect(manage?.getAttribute('href')).toBe('/projects/demo/agents/event-agent?kind=event');
    // The panel already belongs to this workspace, so it does not link to itself.
    expect(container.querySelector('a[href$="/workspaces/workspace-pr"]')).toBeNull();
    expect(requests).toContainEqual({
      path: 'automation.workspaceOrigin',
      input: { projectId: 'owner', workspaceId: 'workspace-pr' },
    });
    expect(requests).toContainEqual({
      path: 'automation.get',
      input: { projectId: 'owner', agentId: 'event-agent' },
    });
  });

  it('shows a retryable error when the origin cannot be read', async () => {
    originFailure = 'Database is locked';
    render();
    await waitForCheck(() => expect(container.textContent).toContain("Couldn't load automation"));
    expect(container.textContent).toContain('Database is locked');
    originFailure = null;
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent?.trim() === 'Retry')
        ?.click()
    );
    await waitForCheck(() => expect(container.textContent).toContain('Investigate labeled issues'));
  });
});
