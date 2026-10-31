// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import mobileToolsStory from './mobile-tool-switcher.stories';
import { RightPanelLayout } from './right-panel-layout';
import { useWorkspacePanel, WorkspacePanelProvider } from './workspace-panel-context';

function Tools() {
  const { mobilePanel, setActiveBottomTab } = useWorkspacePanel();
  return (
    <RightPanelLayout
      workspaceId="mobile-switcher-test"
      isMobile
      mobilePanel={mobilePanel}
      periodicTaskId={null}
      onOpenLogs={() => setActiveBottomTab('dev-logs')}
      topPanel={<input aria-label="Tool draft" defaultValue="Preserved draft" />}
      bottomPanel={<input aria-label="Terminal input" />}
    />
  );
}

describe('mobile tool navigation', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
      configurable: true,
      value: true,
    });
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root.render(
        <WorkspacePanelProvider workspaceId="mobile-switcher-test">
          <Tools />
        </WorkspacePanelProvider>
      )
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  function selectTab(label: string) {
    const tab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
      (element) => element.textContent === label
    );
    expect(tab, `missing ${label} tab`).toBeDefined();
    act(() => {
      tab?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      tab?.click();
    });
    return tab;
  }

  it('selects Terminal when the story argument changes after hydration', () => {
    const Story = mobileToolsStory.component;
    act(() => root.render(<Story initialTool="changes" />));
    act(() => root.render(<Story initialTool="terminal" />));
    const terminal = container.querySelector('[role="tab"][data-state="active"]');
    expect(terminal?.textContent).toBe('Terminal');
    const panel = document.getElementById(terminal?.getAttribute('aria-controls') ?? '');
    expect(panel?.hidden).toBe(false);
    expect(panel?.textContent).toBe('terminal content');
  });

  it('switches directly to Files and exposes exactly one selected tool and panel', () => {
    const files = selectTab('Files');
    expect(files?.getAttribute('aria-selected')).toBe('true');
    const selected = container.querySelectorAll('[role="tab"][aria-selected="true"]');
    expect(selected).toHaveLength(1);
    const panel = document.getElementById(files?.getAttribute('aria-controls') ?? '');
    expect(panel?.getAttribute('role')).toBe('tabpanel');
    expect(panel?.hidden).toBe(false);
    expect(container.querySelector('input[aria-label="Terminal input"]')).toBeNull();
  });

  it('preserves mounted tool and terminal content while switching', () => {
    const draft = container.querySelector('input[aria-label="Tool draft"]');
    const terminal = selectTab('Terminal');
    const terminalInput = container.querySelector('input[aria-label="Terminal input"]');
    expect(terminalInput).not.toBeNull();
    expect(draft?.closest('[hidden]')).not.toBeNull();
    expect(terminal?.getAttribute('aria-selected')).toBe('true');
    selectTab('Changes');
    expect(draft?.closest('[hidden]')).toBeNull();
    expect(container.querySelector('input[aria-label="Tool draft"]')).toBe(draft);
    expect(terminalInput?.closest('[hidden]')).not.toBeNull();
    selectTab('Terminal');
    expect(container.querySelector('input[aria-label="Terminal input"]')).toBe(terminalInput);
  });
});
