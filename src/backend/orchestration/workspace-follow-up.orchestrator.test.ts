import { expect, it, vi } from 'vitest';
import { WorkspaceSnapshotStore } from '@/backend/services/workspace';
import { deriveWorkspaceSidebarStatus } from '@/shared/core';
import { deriveWorkspaceFlowState } from '@/shared/workspace-flow-state';
import { deriveWorkspacePRSummary } from '@/shared/workspace-pr-summary';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { createWorkspaceFollowUp } from './workspace-follow-up.orchestrator';

it.each(['MERGED', 'CLOSED'] as const)(
  'publishes a durable %s follow-up as Waiting and retains Working precedence',
  async (state) => {
    const store = new WorkspaceSnapshotStore();
    store.configure({
      deriveFlowState: (input) => deriveWorkspaceFlowState({ ...input, prUpdatedAt: null }),
      deriveSidebarStatus: deriveWorkspaceSidebarStatus,
    });
    const historical = {
      id: 'pr',
      url: 'https://github.com/org/repo/pull/1',
      number: 1,
      title: null,
      headRefName: null,
      baseRefName: null,
      state,
      reviewState: null,
      ciStatus: 'SUCCESS' as const,
      hasMergeConflict: false,
      syncedAt: null,
    };
    const prs = [{ ...historical, completionDismissed: true }];
    const prSummary = deriveWorkspacePRSummary(prs, true);
    const workspace = {
      id: 'ws',
      projectId: 'project',
      status: 'READY',
      prs,
      prSummary,
      prState: prSummary.state,
      prCiStatus: prSummary.ciStatus,
      ratchetState: prSummary.ratchetState,
      prHasMergeConflict: false,
    };
    const dismissCompletedPRs = vi.fn().mockResolvedValue(prs);
    const ports = unsafeCoerce<Parameters<typeof createWorkspaceFollowUp>[0]>({
      sessionDataService: {
        findAgentSessionById: vi.fn().mockResolvedValue({ workspaceId: 'ws' }),
      },
      workspacePrSnapshotService: { dismissCompletedPRs },
      workspaceDataService: { findById: vi.fn().mockResolvedValue(workspace) },
      workspaceSnapshotStore: store,
    });
    const followUp = createWorkspaceFollowUp(ports);
    try {
      const summary = deriveWorkspacePRSummary([historical], true);
      store.upsert(
        'ws',
        {
          projectId: 'project',
          status: 'READY',
          hasHadSessions: true,
          prs: [historical],
          prSummary: summary,
          prState: summary.state,
          ratchetState: summary.ratchetState,
          ratchetEnabled: true,
        },
        'seed',
        1
      );
      expect(store.getByWorkspaceId('ws')?.kanbanColumn).toBe('DONE');
      const acceptedAt = new Date();
      await followUp('any-conversation', acceptedAt);
      expect(dismissCompletedPRs).toHaveBeenCalledWith('ws', acceptedAt);
      expect(store.getByWorkspaceId('ws')).toMatchObject({
        kanbanColumn: 'WAITING',
        statusReason: { code: 'READY_FOR_NEXT_PROMPT' },
        prs: [expect.objectContaining({ state, completionDismissed: true })],
      });
      store.upsert('ws', { isWorking: true }, 'active', Date.now() + 10);
      expect(store.getByWorkspaceId('ws')?.kanbanColumn).toBe('WORKING');
      store.upsert('ws', { isWorking: false }, 'idle', Date.now() + 20);
      expect(store.getByWorkspaceId('ws')?.kanbanColumn).toBe('WAITING');
      workspace.status = 'ARCHIVED';
      const publish = vi.spyOn(store, 'upsert');
      await followUp('any-conversation', acceptedAt);
      expect(publish).not.toHaveBeenCalled();
      dismissCompletedPRs.mockResolvedValue(prs);
      vi.spyOn(ports.workspaceDataService, 'findById').mockRejectedValueOnce(
        new Error('Read unavailable')
      );
      await expect(followUp('any-conversation', acceptedAt)).resolves.toBeUndefined();
      dismissCompletedPRs.mockResolvedValue(null);
      await followUp('any-conversation', acceptedAt);
      expect(publish).not.toHaveBeenCalled();
    } finally {
      store.clear();
    }
  }
);
