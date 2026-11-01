import { expect, it, vi } from 'vitest';
import { deriveWorkspaceSidebarStatus } from '@/shared/core';
import { deriveWorkspaceFlowState } from '@/shared/workspace-flow-state';
import { WorkspaceSnapshotStore, SNAPSHOT_CHANGED } from './workspace-snapshot-store.service';

it('does not publish another snapshot when reconciliation reloads identical summary values', () => {
  const store = new WorkspaceSnapshotStore();
  store.configure({
    deriveSidebarStatus: deriveWorkspaceSidebarStatus,
    deriveFlowState: (input) =>
      deriveWorkspaceFlowState({
        ...input,
        prUpdatedAt: input.prUpdatedAt ? new Date(input.prUpdatedAt) : null,
      }),
  });
  const summary = {
    title: 'Login fix',
    branch: 'login-fix',
    summary: 'Testing the fix.',
    sidebarSummary: 'Testing login',
    generatedAt: '2026-10-31T12:00:00.000Z',
    sourceSessionId: 's',
    sourceMessageId: 'm',
  };
  try {
    store.upsert('w', { projectId: 'p', conversationSummary: summary }, 'generated', 100);
    const listener = vi.fn();
    store.on(SNAPSHOT_CHANGED, listener);
    expect(store.upsert('w', { conversationSummary: { ...summary } }, 'reconcile', 200)).toEqual({
      accepted: true,
      changed: false,
      emitted: false,
    });
    expect(listener).not.toHaveBeenCalled();
    store.upsert(
      'w',
      { conversationSummary: { ...summary, summary: 'Fix verified.' } },
      'new turn',
      300
    );
    expect(listener).toHaveBeenCalledTimes(1);
  } finally {
    store.clear();
  }
});
