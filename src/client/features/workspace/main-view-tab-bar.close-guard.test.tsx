// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceSessionRuntimeSummary } from '@/client/lib/session-tab-runtime';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  cleanupSubagentTabTestEnvironment,
  setupSubagentTabTestEnvironment,
} from '@/test-utils/subagent-tabs';
import { MainViewTabBar } from './main-view-tab-bar';
import type { SessionQueuedMessageCount } from './session-close-guard';
import { WorkspacePanelProvider } from './workspace-panel-context';

const sessions = [
  { id: 'working', name: 'Refactor auth', status: 'RUNNING' as const },
  { id: 'idle', name: 'Docs pass', status: 'IDLE' as const },
];

const workingSummary: WorkspaceSessionRuntimeSummary = {
  sessionId: 'working',
  name: 'Refactor auth',
  workflow: null,
  model: 'sonnet',
  persistedStatus: 'RUNNING',
  runtimePhase: 'running',
  processState: 'alive',
  activity: 'WORKING',
  updatedAt: '2026-11-03T00:00:00Z',
  lastExit: null,
};

beforeEach(setupSubagentTabTestEnvironment);
afterEach(cleanupSubagentTabTestEnvironment);

async function renderCloseGuard(options: {
  currentSessionId: string;
  queuedMessageCount?: SessionQueuedMessageCount | null;
  summaries?: ReadonlyMap<string, WorkspaceSessionRuntimeSummary>;
}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onCloseSession = vi.fn();
  await act(() =>
    root.render(
      <TooltipProvider>
        <WorkspacePanelProvider workspaceId="close-guard">
          <MainViewTabBar
            workspaceId="close-guard"
            sessions={sessions}
            currentSessionId={options.currentSessionId}
            queuedMessageCount={options.queuedMessageCount}
            sessionSummariesById={options.summaries ?? new Map([['working', workingSummary]])}
            onCloseSession={onCloseSession}
          />
        </WorkspacePanelProvider>
      </TooltipProvider>
    )
  );
  const clickClose = (label: string) =>
    act(() =>
      container.querySelector<HTMLButtonElement>(`button[aria-label="Close ${label}"]`)?.click()
    );
  const dialog = () => document.body.querySelector('[role="alertdialog"]');
  const clickDialogButton = (text: string) =>
    act(() =>
      [...(dialog()?.querySelectorAll('button') ?? [])]
        .find((button) => button.textContent === text)
        ?.click()
    );
  return { root, onCloseSession, clickClose, dialog, clickDialogButton };
}

describe('MainViewTabBar session close guard', () => {
  it('confirms before stopping a working session and keeps it on cancel', async () => {
    const view = await renderCloseGuard({ currentSessionId: 'working' });
    try {
      await view.clickClose('Refactor auth');
      expect(view.onCloseSession).not.toHaveBeenCalled();
      expect(view.dialog()?.textContent).toContain('Refactor auth is still working');

      await view.clickDialogButton('Cancel');
      expect(view.onCloseSession).not.toHaveBeenCalled();

      await view.clickClose('Refactor auth');
      await view.clickDialogButton('Stop and close');
      expect(view.onCloseSession).toHaveBeenCalledExactlyOnceWith('working');
    } finally {
      await act(() => view.root.unmount());
    }
  });

  it('falls back to the persisted RUNNING status without a live summary', async () => {
    const view = await renderCloseGuard({ currentSessionId: 'idle', summaries: new Map() });
    try {
      await view.clickClose('Refactor auth');
      expect(view.onCloseSession).not.toHaveBeenCalled();
      expect(view.dialog()).not.toBeNull();
    } finally {
      await act(() => view.root.unmount());
    }
  });

  it('closes an idle session immediately', async () => {
    // The queued messages belong to the working session, not this one.
    const view = await renderCloseGuard({
      currentSessionId: 'working',
      queuedMessageCount: { sessionId: 'working', count: 3 },
    });
    try {
      await view.clickClose('Docs pass');
      expect(view.onCloseSession).toHaveBeenCalledExactlyOnceWith('idle');
      expect(view.dialog()).toBeNull();
    } finally {
      await act(() => view.root.unmount());
    }
  });

  it('confirms before discarding queued messages in an idle session', async () => {
    const view = await renderCloseGuard({
      currentSessionId: 'idle',
      queuedMessageCount: { sessionId: 'idle', count: 1 },
    });
    try {
      await view.clickClose('Docs pass');
      expect(view.onCloseSession).not.toHaveBeenCalled();
      expect(view.dialog()?.textContent).toContain('1 queued message that has not been sent');

      await view.clickDialogButton('Discard and close');
      expect(view.onCloseSession).toHaveBeenCalledExactlyOnceWith('idle');
    } finally {
      await act(() => view.root.unmount());
    }
  });

  // Regression: during a tab switch the chat state still holds the previous
  // session's queue, so the count must follow its owner, not the selection.
  it('charges a stale queue to its owning session after switching tabs', async () => {
    const view = await renderCloseGuard({
      currentSessionId: 'working',
      queuedMessageCount: { sessionId: 'idle', count: 2 },
    });
    try {
      await view.clickClose('Docs pass');
      expect(view.onCloseSession).not.toHaveBeenCalled();
      expect(view.dialog()?.textContent).toContain('2 queued messages');
    } finally {
      await act(() => view.root.unmount());
    }
  });

  it('does not charge a queue to a session it does not belong to', async () => {
    const idleSummaries = new Map<string, WorkspaceSessionRuntimeSummary>([
      ['working', { ...workingSummary, runtimePhase: 'idle', activity: 'IDLE' }],
    ]);
    const view = await renderCloseGuard({
      currentSessionId: 'working',
      queuedMessageCount: { sessionId: 'idle', count: 2 },
      summaries: idleSummaries,
    });
    try {
      await view.clickClose('Refactor auth');
      expect(view.onCloseSession).toHaveBeenCalledExactlyOnceWith('working');
      expect(view.dialog()).toBeNull();
    } finally {
      await act(() => view.root.unmount());
    }
  });
});
