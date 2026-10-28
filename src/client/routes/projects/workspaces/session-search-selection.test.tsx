// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import {
  useWorkspacePanel,
  WorkspacePanelProvider,
} from '@/client/features/workspace/workspace-panel-context';
import { useSelectedSessionId } from './use-workspace-detail-hooks';

vi.mock('@/client/lib/trpc', () => ({ trpc: {} }));
vi.mock('@/hooks/use-mobile', () => ({ MOBILE_BREAKPOINT: 768, useIsMobile: () => false }));
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

function SelectionProbe({
  requested,
  ids,
  onSelect,
  onLinkedSession,
}: {
  requested: string;
  ids: string[];
  onSelect: (id: string | null) => void;
  onLinkedSession?: () => void;
}) {
  onSelect(
    useSelectedSessionId('ws', 'first', ids, requested, onLinkedSession).selectedDbSessionId
  );
  return null;
}

function LinkedPanelProbe() {
  const { activeTabId, selectTab } = useWorkspacePanel();
  useSelectedSessionId('ws', 'first', ['first', 'second'], 'second', () => selectTab('chat'));
  return <output>{activeTabId}</output>;
}

describe('conversation search selection', () => {
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
        root.render(<SelectionProbe requested="missing" ids={['first']} onSelect={onSelect} />)
      );
      expect(selected).toBe('first');
    } finally {
      await act(() => root.unmount());
    }
  });
});
