// @vitest-environment jsdom
import { act, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useWorkspacePanel,
  WorkspacePanelProvider,
} from '@/client/features/workspace/workspace-panel-context';
import { useSelectedSessionId } from './use-workspace-detail-hooks';

vi.mock('@/client/lib/trpc', () => ({ trpc: {} }));
vi.mock('@/hooks/use-mobile', () => ({ MOBILE_BREAKPOINT: 768, useIsMobile: () => false }));
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({ matches: false })),
  });
});

function SelectionProbe({
  requested,
  ids,
  onSelect,
  onLinkedSession,
  initial = 'first',
}: {
  requested: string;
  ids: string[];
  onSelect: (id: string | null) => void;
  onLinkedSession?: () => void;
  initial?: string | null;
}) {
  onSelect(
    useSelectedSessionId('ws', initial, ids, requested, onLinkedSession).selectedDbSessionId
  );
  return null;
}

function LinkedPanelProbe({
  requested = 'second',
  navigationKey,
}: {
  requested?: string | null;
  navigationKey?: string;
}) {
  const { activeTabId, selectTab } = useWorkspacePanel();
  const activate = useCallback(() => selectTab('chat'), [selectTab]);
  useSelectedSessionId('ws', 'first', ['first', 'second'], requested, activate, navigationKey);
  return (
    <>
      <output>{activeTabId}</output>
      <button type="button" onClick={() => selectTab('file:README.md')}>
        Open file
      </button>
    </>
  );
}

describe('conversation search selection', () => {
  it('activates chat when the same conversation URL is selected again after opening a file', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(() =>
        root.render(
          <WorkspacePanelProvider workspaceId="ws" initialActiveTabId="chat">
            <LinkedPanelProbe navigationKey="first-navigation" />
          </WorkspacePanelProvider>
        )
      );
      await act(() => container.querySelector('button')?.click());
      expect(container.querySelector('output')?.textContent).toBe('file:README.md');
      await act(() =>
        root.render(
          <WorkspacePanelProvider workspaceId="ws" initialActiveTabId="chat">
            <LinkedPanelProbe navigationKey="next-navigation" />
          </WorkspacePanelProvider>
        )
      );
      expect(container.querySelector('output')?.textContent).toBe('chat');
    } finally {
      await act(() => root.unmount());
    }
  });
  it('restores the file tab before a later conversation link selects chat', async () => {
    localStorage.setItem(
      'workspace-panel-tabs-ws',
      JSON.stringify([
        { id: 'chat', type: 'chat', label: 'Chat' },
        { id: 'file:README.md', type: 'file', path: 'README.md', label: 'README.md' },
      ])
    );
    localStorage.setItem('workspace-panel-active-tab-ws', 'file:README.md');
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(() =>
        root.render(
          <WorkspacePanelProvider workspaceId="ws">
            <LinkedPanelProbe requested={null} />
          </WorkspacePanelProvider>
        )
      );
      expect(container.querySelector('output')?.textContent).toBe('file:README.md');
      await act(() =>
        root.render(
          <WorkspacePanelProvider workspaceId="ws">
            <LinkedPanelProbe requested="second" />
          </WorkspacePanelProvider>
        )
      );
      expect(container.querySelector('output')?.textContent).toBe('chat');
    } finally {
      await act(() => root.unmount());
    }
  });
  it('uses the linked conversation from the very first render', async () => {
    localStorage.setItem('workspace-selected-session-ws', 'first');
    const rendered: (string | null)[] = [];
    const root = createRoot(document.createElement('div'));
    try {
      await act(() =>
        root.render(
          <SelectionProbe
            requested="second"
            ids={['first', 'second']}
            onSelect={(id) => rendered.push(id)}
          />
        )
      );
      expect(rendered[0]).toBe('second');
    } finally {
      await act(() => root.unmount());
    }
  });
  it('keeps linked chat visible when a destination workspace restores its saved file tab', async () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: false })),
    });
    localStorage.clear();
    localStorage.setItem(
      'workspace-panel-tabs-ws',
      JSON.stringify([
        { id: 'chat', type: 'chat', label: 'Chat' },
        { id: 'file:README.md', type: 'file', path: 'README.md', label: 'README.md' },
      ])
    );
    localStorage.setItem('workspace-panel-active-tab-ws', 'file:README.md');
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(() =>
        root.render(
          <WorkspacePanelProvider workspaceId="ws" initialActiveTabId="chat">
            <LinkedPanelProbe />
          </WorkspacePanelProvider>
        )
      );
      expect(container.querySelector('output')?.textContent).toBe('chat');
    } finally {
      await act(() => root.unmount());
    }
  });
  it('activates the chat panel when a valid conversation link is consumed', async () => {
    const activate = vi.fn();
    const root = createRoot(document.createElement('div'));
    try {
      await act(() =>
        root.render(
          <SelectionProbe
            requested="second"
            ids={['first', 'second']}
            onSelect={vi.fn()}
            onLinkedSession={activate}
          />
        )
      );
      expect(activate).toHaveBeenCalledOnce();
    } finally {
      await act(() => root.unmount());
    }
  });
  it('selects a linked conversation after sessions load and handles a new link in the same workspace', async () => {
    localStorage.clear();
    let selected: string | null = null;
    const onSelect = (id: string | null) => {
      selected = id;
    };
    const root = createRoot(document.createElement('div'));
    try {
      await act(() =>
        root.render(<SelectionProbe requested="second" ids={[]} onSelect={onSelect} />)
      );
      await act(() =>
        root.render(
          <SelectionProbe requested="second" ids={['first', 'second']} onSelect={onSelect} />
        )
      );
      expect(selected).toBe('second');
      await act(() =>
        root.render(
          <SelectionProbe requested="first" ids={['first', 'second']} onSelect={onSelect} />
        )
      );
      expect(selected).toBe('first');
      expect(localStorage.getItem('workspace-selected-session-ws')).toBe('first');
    } finally {
      await act(() => root.unmount());
    }
  });

  it('falls back safely when a linked conversation no longer exists', async () => {
    localStorage.clear();
    let selected: string | null = null;
    const onSelect = (id: string | null) => {
      selected = id;
    };
    const root = createRoot(document.createElement('div'));
    try {
      await act(() =>
        root.render(
          <SelectionProbe requested="missing" initial={null} ids={['first']} onSelect={onSelect} />
        )
      );
      expect(selected).toBe('first');
    } finally {
      await act(() => root.unmount());
    }
  });
});
