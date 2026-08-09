// @vitest-environment jsdom

import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentsPanel } from './agents-panel';

const mocks = vi.hoisted(() => ({
  childProps: vi.fn(),
  providerProps: vi.fn(),
  queryBacked: false,
  querySubagents: vi.fn<(sessionId: string) => Promise<string>>(),
}));

vi.mock('@/client/features/subagents', () => ({
  ProviderSubagentsSection: (props: {
    sessionId: string | null;
    enabled: boolean;
    onSelect: (selection: unknown) => void;
  }) => {
    mocks.providerProps(props);
    if (mocks.queryBacked) {
      return createElement(QueryBackedProviderSection, props);
    }
    return createElement('section', { 'data-testid': 'provider-subagents' }, props.sessionId);
  },
}));

function QueryBackedProviderSection({
  sessionId,
  enabled,
}: {
  sessionId: string | null;
  enabled: boolean;
}) {
  const { data } = useQuery({
    queryKey: ['session', 'listSubagents', sessionId],
    queryFn: () => mocks.querySubagents(sessionId ?? ''),
    enabled: Boolean(sessionId && enabled),
    refetchOnMount: 'always',
    staleTime: 5000,
  });
  return createElement('section', { 'data-testid': 'provider-subagents' }, data ?? 'Loading');
}

vi.mock('./child-workspaces-panel', () => ({
  ChildWorkspacesPanel: (props: { workspaceId: string; embedded?: boolean }) => {
    mocks.childProps(props);
    return createElement('section', { 'data-testid': 'child-workspaces' }, props.workspaceId);
  },
}));

describe('AgentsPanel', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
      configurable: true,
      writable: true,
      value: true,
    });
    mocks.queryBacked = false;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    void act(() => root.unmount());
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  function render(props: Parameters<typeof AgentsPanel>[0]): void {
    void act(() => root.render(createElement(AgentsPanel, props)));
  }

  it('scopes provider agents to the selected session and child workspaces to the workspace', () => {
    const onOpenSubagent = vi.fn();
    render({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      sessionReady: true,
      isParentWorkspace: true,
      onOpenSubagent,
    });

    expect(mocks.providerProps).toHaveBeenLastCalledWith({
      sessionId: 'session-1',
      enabled: true,
      onSelect: onOpenSubagent,
    });
    expect(mocks.childProps).toHaveBeenLastCalledWith({
      workspaceId: 'workspace-1',
      embedded: true,
    });
    expect(container.querySelector('[data-testid="provider-subagents"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="child-workspaces"]')).not.toBeNull();
  });

  it('keeps child workspaces workspace-scoped when the selected session changes', () => {
    const props = {
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      sessionReady: true,
      isParentWorkspace: true,
      onOpenSubagent: vi.fn(),
    };
    render(props);
    render({ ...props, sessionId: 'session-2' });

    expect(mocks.providerProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: 'session-2' })
    );
    expect(
      mocks.childProps.mock.calls.every(([childProps]) => childProps.workspaceId === 'workspace-1')
    ).toBe(true);
    expect(mocks.childProps.mock.calls.every(([childProps]) => !('sessionId' in childProps))).toBe(
      true
    );
  });

  it('keeps provider sub-agents available but omits children for child workspaces', () => {
    render({
      workspaceId: 'child-workspace',
      sessionId: 'session-child',
      sessionReady: true,
      isParentWorkspace: false,
      onOpenSubagent: vi.fn(),
    });

    expect(container.querySelector('[data-testid="provider-subagents"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="child-workspaces"]')).toBeNull();
  });

  it('authoritatively refreshes A after switching A to B to A without refetching unchanged A', async () => {
    mocks.queryBacked = true;
    let sessionAVersion = 0;
    mocks.querySubagents.mockImplementation((sessionId) => {
      if (sessionId === 'session-a') {
        sessionAVersion += 1;
        return Promise.resolve(`Session A version ${sessionAVersion}`);
      }
      return Promise.resolve('Session B version 1');
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 5000 } },
    });
    const commonProps = {
      workspaceId: 'workspace-1',
      sessionReady: true,
      isParentWorkspace: false,
      onOpenSubagent: vi.fn(),
    };
    const renderSelectedSession = async (sessionId: string) => {
      await act(() => {
        root.render(
          createElement(
            QueryClientProvider,
            { client: queryClient },
            createElement(AgentsPanel, { ...commonProps, sessionId })
          )
        );
      });
    };
    const waitForText = async (text: string) => {
      await act(async () => {
        await vi.waitFor(() => expect(container.textContent).toContain(text));
      });
    };

    await renderSelectedSession('session-a');
    await waitForText('Session A version 1');

    await renderSelectedSession('session-a');
    await act(async () => Promise.resolve());
    expect(
      mocks.querySubagents.mock.calls.filter(([sessionId]) => sessionId === 'session-a')
    ).toHaveLength(1);

    await renderSelectedSession('session-b');
    await waitForText('Session B version 1');

    await renderSelectedSession('session-a');
    await waitForText('Session A version 2');
    expect(
      mocks.querySubagents.mock.calls.filter(([sessionId]) => sessionId === 'session-a')
    ).toHaveLength(2);
  });
});
