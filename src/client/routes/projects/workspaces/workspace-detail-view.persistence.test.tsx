// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { WorkspaceDetailView, type WorkspaceDetailViewProps } from './workspace-detail-view';

// Mock workspace content only; exercise the real resizable wrapper and v4 library.
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/client/features/workspace', () => ({
  WorkspaceContentView: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  RightPanel: () => <aside>Mock workspace files</aside>,
  ArchiveWorkspaceDialog: () => null,
}));
vi.mock('./workspace-detail-chat-content', () => ({
  ChatContent: () => <div data-testid="chat">Mock workspace chat</div>,
}));
vi.mock('./auto-iteration-progress-banner', () => ({ AutoIterationProgressBanner: () => null }));
vi.mock('./workspace-overlays', () => ({
  ArchivingOverlay: () => null,
  ScriptFailedBanner: () => null,
}));

const storageKey = 'resizable-panels:workspace-main-panel';
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    }
  );
  // jsdom has no layout engine. Give the real library a measurable group/panels.
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(800);
  localStorage.clear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function render(workspaceId: string, visible = true) {
  const props = {
    workspaceState: {
      workspaceId,
      workspace: { id: workspaceId, mode: 'STANDARD' },
      workspaceLoading: false,
      isScriptFailed: false,
      setupWarningDismissed: false,
    },
    header: { archivePending: false, isCreatingSession: false },
    sessionTabs: { sessions: [], sessionSummariesById: new Map() },
    chat: { messages: [] },
    rightPanelVisible: visible,
    setRightPanelVisible: vi.fn(),
    archiveDialog: { open: false, activeChildCount: 0 },
  } as unknown as WorkspaceDetailViewProps;
  await act(() => root.render(<WorkspaceDetailView key={workspaceId} {...props} />));
}

function sizes() {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-panel]'), (panel) =>
    Number(panel.style.flexGrow)
  );
}

async function resize() {
  const handle = container.querySelector('[role="separator"]');
  expect(handle).not.toBeNull();
  await act(() => {
    handle!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  });
}

describe('workspace split persistence with real panels', () => {
  it('restores a saved split on mount and keeps it through close/open', async () => {
    const stored = JSON.stringify({ 'workspace-chat': 60, 'workspace-side': 40 });
    localStorage.setItem(storageKey, stored);
    await render('mock-a');
    expect(sizes()).toEqual([60, 40]);
    const chat = container.querySelector('[data-testid="chat"]');
    await render('mock-a', false);
    expect(sizes()).toEqual([100]);
    expect(localStorage.getItem(storageKey)).toBe(stored);
    await render('mock-a');
    expect(sizes()).toEqual([60, 40]);
    expect(container.querySelector('[data-testid="chat"]')).toBe(chat);
  });

  it('shares the latest user resize across workspace switches and reloads', async () => {
    await render('mock-a');
    await resize();
    const preferred = sizes();
    expect(preferred).not.toEqual([70, 30]);
    const stored = localStorage.getItem(storageKey);
    expect(stored).not.toBeNull();
    await render('mock-a', false);
    await render('mock-a');
    expect(sizes()).toEqual(preferred);
    await render('mock-b');
    expect(sizes()).toEqual(preferred);
    await resize();
    const latest = sizes();
    expect(latest).not.toEqual(preferred);
    await render('mock-a', false);
    await act(() => vi.advanceTimersByTime(1000));
    await render('mock-a');
    expect(sizes()).toEqual(latest);
    await act(() => root.unmount());
    root = createRoot(container);
    await render('mock-reload');
    expect(sizes()).toEqual(latest);
    expect(Object.keys(localStorage)).toEqual([storageKey]);
  });

  it.each(['[data-separator]', '[data-panel]'])(
    'persists a double-click reset on %s across workspace switches',
    async (target) => {
      // The library resolves double-click hit regions from actual DOM geometry.
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: HTMLElement
      ) {
        const isSide = this.id === 'workspace-side';
        const isHandle = this.hasAttribute('data-separator');
        const x = isSide || isHandle ? 650 : 0;
        const width = isHandle ? 1 : isSide ? 350 : 1000;
        return {
          x,
          y: 0,
          width,
          height: 800,
          top: 0,
          left: x,
          right: x + width,
          bottom: 800,
          toJSON: () => ({}),
        };
      });
      await render('mock-a');
      await resize();
      expect(sizes()).toEqual([65, 35]);
      await act(() => {
        container.querySelector(target)!.dispatchEvent(
          new MouseEvent('dblclick', {
            bubbles: true,
            cancelable: true,
            clientX: 650,
            clientY: 400,
          })
        );
      });
      expect(sizes()).toEqual([70, 30]);
      await render('mock-b');
      expect(sizes()).toEqual([70, 30]);
    }
  );

  it('does not save when workspace content is double-clicked', async () => {
    await render('mock-a');
    const save = vi.spyOn(Storage.prototype, 'setItem');
    await act(() => {
      container.querySelector('[data-testid="chat"]')!.dispatchEvent(
        new MouseEvent('dblclick', {
          bubbles: true,
          cancelable: true,
          clientX: 100,
          clientY: 400,
        })
      );
    });
    expect(save).not.toHaveBeenCalled();
  });

  it('saves the outer reset when its hit region overlaps nested panel content', async () => {
    const rects: Record<string, [number, number, number, number]> = {
      'outer-chat': [0, 0, 650, 800],
      'outer-side': [650, 0, 350, 800],
      'outer-handle': [650, 0, 1, 800],
      inner: [650, 0, 350, 800],
      'inner-files': [650, 0, 350, 480],
      'inner-handle': [650, 480, 350, 1],
      'inner-terminal': [650, 480, 350, 320],
    };
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      const [x, y, width, height] = rects[this.id] ?? [0, 0, 1000, 800];
      return new DOMRect(x, y, width, height);
    });
    await act(() =>
      root.render(
        <ResizablePanelGroup autoSaveId="outer">
          <ResizablePanel id="outer-chat" defaultSize="70%">
            Chat
          </ResizablePanel>
          <ResizableHandle id="outer-handle" />
          <ResizablePanel id="outer-side" defaultSize="30%">
            <ResizablePanelGroup autoSaveId="inner" direction="vertical">
              <ResizablePanel id="inner-files" defaultSize="60%">
                Files
              </ResizablePanel>
              <ResizableHandle id="inner-handle" direction="vertical" />
              <ResizablePanel id="inner-terminal" defaultSize="40%">
                Terminal
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>
        </ResizablePanelGroup>
      )
    );
    await act(() => {
      container
        .querySelector('#outer-handle')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    expect(localStorage.getItem('resizable-panels:outer')).toBe(
      JSON.stringify({ 'outer-chat': 65, 'outer-side': 35 })
    );
    const innerLayout = localStorage.getItem('resizable-panels:inner');
    const save = vi.spyOn(Storage.prototype, 'setItem');
    await act(() => {
      container.querySelector('#inner-files')!.dispatchEvent(
        new MouseEvent('dblclick', {
          bubbles: true,
          cancelable: true,
          clientX: 652,
          clientY: 100,
        })
      );
    });
    expect(localStorage.getItem('resizable-panels:outer')).toBe(
      JSON.stringify({ 'outer-chat': 70, 'outer-side': 30 })
    );
    expect(localStorage.getItem('resizable-panels:inner')).toBe(innerLayout);
    expect(save).toHaveBeenCalledExactlyOnceWith(
      'resizable-panels:outer',
      JSON.stringify({ 'outer-chat': 70, 'outer-side': 30 })
    );
  });
});
