// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { trpc } from '@/client/lib/trpc';
import {
  resolveSelectedSessionId,
  useWorkspaceHasChanges,
  useWorkspaceInitStatus,
} from './use-workspace-detail-hooks';

const getInitStatusUseQueryMock = vi.hoisted(() => vi.fn());
const hasChangesUseQueryMock = vi.hoisted(() => vi.fn());
const workspaceGetInvalidateMock = vi.hoisted(() => vi.fn());
const workspaceHasChangesInvalidateMock = vi.hoisted(() => vi.fn());

vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      workspace: {
        get: {
          invalidate: workspaceGetInvalidateMock,
        },
        hasChanges: {
          invalidate: workspaceHasChangesInvalidateMock,
        },
      },
    }),
    workspace: {
      getInitStatus: {
        useQuery: getInitStatusUseQueryMock,
      },
      hasChanges: {
        useQuery: hasChangesUseQueryMock,
      },
    },
  },
}));

beforeEach(() => {
  hasChangesUseQueryMock.mockReturnValue({ data: false });
  workspaceHasChangesInvalidateMock.mockResolvedValue(undefined);
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

function HasChangesProbe({
  workspaceId = 'workspace-1',
  running,
  prState = 'NONE',
}: {
  workspaceId?: string;
  running: boolean;
  prState?: 'NONE' | 'OPEN';
}) {
  const utils = trpc.useUtils();
  useWorkspaceHasChanges(workspaceId, { hasHadSessions: true, prState }, running, utils);
  return null;
}

describe('useWorkspaceHasChanges', () => {
  it('invalidates hasChanges when a running session stops', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(createElement(HasChangesProbe, { running: true }));
    });
    expect(workspaceHasChangesInvalidateMock).not.toHaveBeenCalled();

    flushSync(() => {
      root.render(createElement(HasChangesProbe, { running: false }));
    });
    expect(workspaceHasChangesInvalidateMock).toHaveBeenCalledOnce();
    expect(workspaceHasChangesInvalidateMock).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
    });

    root.unmount();
  });

  it('does not invalidate for an initially stopped workspace', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(createElement(HasChangesProbe, { running: false }));
    });

    expect(workspaceHasChangesInvalidateMock).not.toHaveBeenCalled();
    root.unmount();
  });

  it('does not treat navigation to a stopped workspace as a session completion', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(createElement(HasChangesProbe, { workspaceId: 'workspace-1', running: true }));
    });
    flushSync(() => {
      root.render(createElement(HasChangesProbe, { workspaceId: 'workspace-2', running: false }));
    });

    expect(workspaceHasChangesInvalidateMock).not.toHaveBeenCalled();
    root.unmount();
  });

  it('does not invalidate when the workspace already has a pull request', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(createElement(HasChangesProbe, { running: true, prState: 'OPEN' }));
    });
    flushSync(() => {
      root.render(createElement(HasChangesProbe, { running: false, prState: 'OPEN' }));
    });

    expect(workspaceHasChangesInvalidateMock).not.toHaveBeenCalled();
    root.unmount();
  });
});

function InitialInitStatusProbe({ observedStates }: { observedStates: Array<boolean | null> }) {
  const utils = trpc.useUtils();
  const { setupWarningDismissed } = useWorkspaceInitStatus('workspace-1', undefined, utils);
  observedStates.push(setupWarningDismissed);
  return null;
}

function WorkspaceInitStatusProbe({
  workspaceId,
  observedStates,
}: {
  workspaceId: string;
  observedStates: Array<{ workspaceId: string; dismissed: boolean | null }>;
}) {
  const utils = trpc.useUtils();
  const { setupWarningDismissed } = useWorkspaceInitStatus(workspaceId, undefined, utils);
  observedStates.push({ workspaceId, dismissed: setupWarningDismissed });
  return null;
}

describe('useWorkspaceInitStatus', () => {
  it('starts with an unhydrated setup warning dismissal state', () => {
    getInitStatusUseQueryMock.mockReturnValue({ data: undefined, isPending: true });
    const observedStates: Array<boolean | null> = [];

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(createElement(InitialInitStatusProbe, { observedStates }));
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

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(
        createElement(WorkspaceInitStatusProbe, { workspaceId: 'workspace-1', observedStates })
      );
    });
    await vi.waitFor(() => {
      expect(observedStates.at(-1)).toEqual({ workspaceId: 'workspace-1', dismissed: false });
    });

    observedStates.length = 0;
    flushSync(() => {
      root.render(
        createElement(WorkspaceInitStatusProbe, { workspaceId: 'workspace-2', observedStates })
      );
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
