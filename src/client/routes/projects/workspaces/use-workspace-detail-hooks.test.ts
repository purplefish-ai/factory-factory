// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trpc } from '@/client/lib/trpc';
import { resolveSelectedSessionId, useWorkspaceInitStatus } from './use-workspace-detail-hooks';

const getInitStatusUseQueryMock = vi.hoisted(() => vi.fn());

vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      workspace: {
        get: {
          invalidate: vi.fn(),
        },
      },
    }),
    workspace: {
      getInitStatus: {
        useQuery: getInitStatusUseQueryMock,
      },
    },
  },
}));

afterEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('useWorkspaceInitStatus', () => {
  it('starts with an unhydrated setup warning dismissal state', () => {
    getInitStatusUseQueryMock.mockReturnValue({ data: undefined, isPending: true });
    const observedStates: Array<boolean | null> = [];

    function Probe() {
      const utils = trpc.useUtils();
      const { setupWarningDismissed } = useWorkspaceInitStatus('workspace-1', undefined, utils);
      observedStates.push(setupWarningDismissed);
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(createElement(Probe));
    });

    expect(observedStates[0]).toBeNull();

    root.unmount();
  });

  it('returns to an unhydrated dismissal state when the workspace changes', async () => {
    const initStatus = {
      status: 'READY',
      initErrorMessage: 'Setup failed',
      chatBanner: { showDismiss: true },
      hasWorktreePath: true,
    };
    getInitStatusUseQueryMock.mockReturnValue({ data: initStatus, isPending: false });
    const observedStates: Array<{ workspaceId: string; dismissed: boolean | null }> = [];

    function Probe({ workspaceId }: { workspaceId: string }) {
      const utils = trpc.useUtils();
      const { setupWarningDismissed } = useWorkspaceInitStatus(workspaceId, undefined, utils);
      observedStates.push({ workspaceId, dismissed: setupWarningDismissed });
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(createElement(Probe, { workspaceId: 'workspace-1' }));
    });
    await vi.waitFor(() => {
      expect(observedStates.at(-1)).toEqual({ workspaceId: 'workspace-1', dismissed: false });
    });

    observedStates.length = 0;
    flushSync(() => {
      root.render(createElement(Probe, { workspaceId: 'workspace-2' }));
    });

    expect(observedStates[0]).toEqual({ workspaceId: 'workspace-2', dismissed: null });

    root.unmount();
  });
});

describe('resolveSelectedSessionId', () => {
  it('keeps current selection while sessions are still loading', () => {
    const selected = resolveSelectedSessionId({
      currentSelectedDbSessionId: 's2',
      persistedSessionId: 's2',
      initialDbSessionId: 's1',
      sessionIds: [],
    });

    expect(selected).toBe('s2');
  });

  it('keeps current selection when still valid', () => {
    const selected = resolveSelectedSessionId({
      currentSelectedDbSessionId: 's2',
      persistedSessionId: 's1',
      initialDbSessionId: 's1',
      sessionIds: ['s1', 's2'],
    });

    expect(selected).toBe('s2');
  });

  it('restores persisted selection when current is invalid', () => {
    const selected = resolveSelectedSessionId({
      currentSelectedDbSessionId: 'missing',
      persistedSessionId: 's2',
      initialDbSessionId: 's1',
      sessionIds: ['s1', 's2'],
    });

    expect(selected).toBe('s2');
  });

  it('falls back to initial session when persisted is not available', () => {
    const selected = resolveSelectedSessionId({
      currentSelectedDbSessionId: null,
      persistedSessionId: 'missing',
      initialDbSessionId: 's2',
      sessionIds: ['s1', 's2'],
    });

    expect(selected).toBe('s2');
  });

  it('preserves a pending explicit selection while session list catches up', () => {
    const selected = resolveSelectedSessionId({
      currentSelectedDbSessionId: 's3',
      persistedSessionId: 's3',
      initialDbSessionId: 's1',
      sessionIds: ['s1', 's2'],
      pendingSelectionId: 's3',
      pendingSelectionSetAtMs: 1000,
      nowMs: 1200,
    });

    expect(selected).toBe('s3');
  });

  it('does not preserve pending selection after grace period expires', () => {
    const selected = resolveSelectedSessionId({
      currentSelectedDbSessionId: 's3',
      persistedSessionId: 's3',
      initialDbSessionId: 's1',
      sessionIds: ['s1', 's2'],
      pendingSelectionId: 's3',
      pendingSelectionSetAtMs: 1000,
      nowMs: 7000,
    });

    expect(selected).toBe('s1');
  });

  it('falls back to the first session when no preference is valid', () => {
    const selected = resolveSelectedSessionId({
      currentSelectedDbSessionId: null,
      persistedSessionId: 'missing',
      initialDbSessionId: 'also-missing',
      sessionIds: ['s1', 's2'],
    });

    expect(selected).toBe('s1');
  });
});
