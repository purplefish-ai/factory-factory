import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import type { WorkspacePullRequest } from '@/shared/workspace-pr';
import { deriveWorkspacePRSummary } from '@/shared/workspace-pr-summary';
import type { WorkspaceWithKanban } from './kanban-card';
import { KanbanCard } from './kanban-card';

const meta = {
  title: 'Kanban/KanbanCard',
  component: KanbanCard,
  parameters: {
    layout: 'centered',
    nextjs: {
      appDirectory: true,
    },
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="w-[380px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof KanbanCard>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * One row of the shared project workspace list. Exported so the board and
 * column stories build on the same shape the endpoint actually returns.
 */
export const baseWorkspace: WorkspaceWithKanban = {
  id: 'ws-1',
  projectId: 'proj-1',
  name: 'Add user authentication',
  status: 'READY',
  worktreePath: '/tmp/story-worktree',
  createdAt: new Date(),
  branchName: 'feature/auth',
  initErrorMessage: null,
  mode: 'STANDARD',
  autoIterationStatus: null,
  autoIterationConfig: null,
  autoIterationProgress: null,
  prs: [],
  prSummary: deriveWorkspacePRSummary([], true),
  prUrl: null,
  prNumber: null,
  prState: 'NONE',
  prCiStatus: 'UNKNOWN',
  ratchetEnabled: true,
  ratchetState: 'IDLE',
  runScriptStatus: 'IDLE',
  wakeScheduleEnabled: false,
  wakeScheduleCadence: null,
  wakeScheduleNextWakeAt: null,
  githubIssueNumber: null,
  githubIssueUrl: null,
  linearIssueId: null,
  linearIssueIdentifier: null,
  linearIssueUrl: null,
  creationSource: 'MANUAL',
  sessionSummaries: [],
  pendingRequestType: null,
  gitStats: null,
  lastActivityAt: null,
  isWorking: false,
  kanbanColumn: 'WORKING',
  sidebarStatus: { activityState: 'IDLE', ciState: 'NONE' },
  ratchetButtonAnimated: false,
  flowPhase: 'NO_PR',
  ciObservation: 'NOT_FETCHED',
  statusReason: {
    code: 'READY_FOR_NEXT_PROMPT',
    label: 'Ready',
    tone: 'neutral',
    needsUser: false,
  },
};

/** Keep the cached legacy fields and the attached collection consistent. */
function withPR(overrides: Partial<WorkspaceWithKanban>): WorkspaceWithKanban {
  const workspace = { ...baseWorkspace, ...overrides };
  const pr: WorkspacePullRequest = {
    id: `pr-${workspace.prNumber}`,
    url: workspace.prUrl!,
    number: workspace.prNumber,
    title: workspace.name,
    headRefName: workspace.branchName,
    baseRefName: 'main',
    state: workspace.prState,
    reviewState:
      workspace.prState === 'APPROVED' || workspace.prState === 'CHANGES_REQUESTED'
        ? workspace.prState
        : null,
    ciStatus: workspace.prCiStatus,
    hasMergeConflict: false,
    syncedAt: null,
    ratchet: {
      lastCheckedAt: null,
      dispatchOutcome: null,
      dispatchRetryCount: 0,
      dispatchStalled: false,
    },
  };
  return {
    ...workspace,
    prs: [pr],
    prSummary: deriveWorkspacePRSummary([pr], workspace.ratchetEnabled),
  };
}

export const NoPR: Story = {
  args: {
    workspace: baseWorkspace,
    projectSlug: 'my-project',
  },
};

export const WakeSchedule: Story = {
  args: {
    workspace: {
      ...baseWorkspace,
      name: 'Log watcher',
      wakeScheduleEnabled: true,
      wakeScheduleCadence: 'EVERY_HOUR',
      wakeScheduleNextWakeAt: new Date('2026-10-01T15:00:00Z'),
    },
    projectSlug: 'my-project',
  },
};

export const GitHubIssue: Story = {
  args: {
    workspace: {
      ...baseWorkspace,
      name: 'Fix session timeout handling',
      githubIssueNumber: 1905,
      githubIssueUrl: 'https://github.com/example/repo/issues/1905',
    },
    projectSlug: 'my-project',
  },
};

export const LinearIssue: Story = {
  args: {
    workspace: {
      ...baseWorkspace,
      name: 'Add SSO configuration',
      linearIssueId: 'linear-42',
      linearIssueIdentifier: 'ENG-42',
      linearIssueUrl: 'https://linear.app/example/issue/ENG-42',
    },
    projectSlug: 'my-project',
  },
};

export const IssueAndPRWithCIRunning: Story = {
  args: {
    workspace: withPR({
      name: 'Tighten Kanban card styling',
      githubIssueNumber: 1905,
      githubIssueUrl: 'https://github.com/example/repo/issues/1905',
      prUrl: 'https://github.com/example/repo/pull/57',
      prNumber: 57,
      prState: 'DRAFT',
      prCiStatus: 'PENDING',
      flowPhase: 'CI_WAIT',
      ciObservation: 'CHECKS_PENDING',
      statusReason: {
        code: 'WAITING_FOR_CI',
        label: 'Waiting for CI',
        tone: 'waiting',
        needsUser: false,
      },
    }),
    projectSlug: 'my-project',
  },
};

export const DraftPR: Story = {
  args: {
    workspace: withPR({
      prUrl: 'https://github.com/example/repo/pull/42',
      prNumber: 42,
      prState: 'DRAFT',
    }),
    projectSlug: 'my-project',
  },
};

export const OpenPR: Story = {
  args: {
    workspace: withPR({
      prUrl: 'https://github.com/example/repo/pull/43',
      prNumber: 43,
      prState: 'OPEN',
      prCiStatus: 'PENDING',
    }),
    projectSlug: 'my-project',
  },
};

export const ChangesRequested: Story = {
  args: {
    workspace: withPR({
      name: 'Fix login validation',
      prUrl: 'https://github.com/example/repo/pull/44',
      prNumber: 44,
      prState: 'CHANGES_REQUESTED',
      prCiStatus: 'SUCCESS',
    }),
    projectSlug: 'my-project',
  },
};

export const Approved: Story = {
  args: {
    workspace: withPR({
      name: 'Add password reset flow',
      prUrl: 'https://github.com/example/repo/pull/45',
      prNumber: 45,
      prState: 'APPROVED',
      prCiStatus: 'SUCCESS',
    }),
    projectSlug: 'my-project',
  },
};

export const Merged: Story = {
  args: {
    workspace: withPR({
      name: 'Implement MFA support',
      prUrl: 'https://github.com/example/repo/pull/46',
      prNumber: 46,
      prState: 'MERGED',
      kanbanColumn: 'DONE',
    }),
    projectSlug: 'my-project',
  },
};

export const Closed: Story = {
  args: {
    workspace: withPR({
      name: 'Deprecated feature branch',
      prUrl: 'https://github.com/example/repo/pull/47',
      prNumber: 47,
      prState: 'CLOSED',
      kanbanColumn: 'WAITING',
    }),
    projectSlug: 'my-project',
  },
};

export const Archived: Story = {
  args: {
    workspace: withPR({
      name: 'Archived workspace',
      prUrl: 'https://github.com/example/repo/pull/50',
      prNumber: 50,
      prState: 'MERGED',
      status: 'ARCHIVED',
      kanbanColumn: 'DONE',
    }),
    projectSlug: 'my-project',
  },
};

export const ArchivedInWaiting: Story = {
  args: {
    workspace: withPR({
      name: 'Archived with open PR',
      prUrl: 'https://github.com/example/repo/pull/51',
      prNumber: 51,
      prState: 'OPEN',
      status: 'ARCHIVED',
      kanbanColumn: 'WAITING',
    }),
    projectSlug: 'my-project',
  },
};

export const Working: Story = {
  args: {
    workspace: withPR({
      name: 'Active coding session',
      isWorking: true,
      prState: 'OPEN',
      prUrl: 'https://github.com/example/repo/pull/48',
      prNumber: 48,
    }),
    projectSlug: 'my-project',
  },
};

export const Provisioning: Story = {
  args: {
    workspace: {
      ...baseWorkspace,
      name: 'New workspace',
      status: 'PROVISIONING',
      branchName: null,
    },
    projectSlug: 'my-project',
  },
};

export const RatchetOnProcessing: Story = {
  args: {
    workspace: withPR({
      name: 'Ratchet fixing CI',
      prState: 'OPEN',
      prUrl: 'https://github.com/example/repo/pull/50',
      prNumber: 50,
      prCiStatus: 'FAILURE',
      ratchetState: 'CI_FAILED',
    }),
    projectSlug: 'my-project',
  },
};

export const RatchetReviewPending: Story = {
  args: {
    workspace: withPR({
      name: 'Ratchet addressing reviews',
      prState: 'CHANGES_REQUESTED',
      prUrl: 'https://github.com/example/repo/pull/51',
      prNumber: 51,
      prCiStatus: 'SUCCESS',
      ratchetState: 'REVIEW_PENDING',
    }),
    projectSlug: 'my-project',
  },
};

export const RatchetReady: Story = {
  args: {
    workspace: withPR({
      name: 'Ratchet ready to merge',
      prState: 'APPROVED',
      prUrl: 'https://github.com/example/repo/pull/52',
      prNumber: 52,
      prCiStatus: 'SUCCESS',
      ratchetState: 'READY',
    }),
    projectSlug: 'my-project',
  },
};

export const RatchetOff: Story = {
  args: {
    workspace: withPR({
      name: 'Ratchet disabled',
      ratchetEnabled: false,
      ratchetState: 'CI_FAILED',
      prState: 'OPEN',
      prUrl: 'https://github.com/example/repo/pull/53',
      prNumber: 53,
    }),
    projectSlug: 'my-project',
  },
};

export const AllPRStates: Story = {
  decorators: [
    () => (
      <div className="flex flex-wrap gap-4">
        {(['DRAFT', 'OPEN', 'CHANGES_REQUESTED', 'APPROVED', 'MERGED', 'CLOSED'] as const).map(
          (state, index) => (
            <div key={state} className="w-[380px]">
              <KanbanCard
                workspace={withPR({
                  prState: state,
                  prNumber: index + 1,
                  prUrl: `https://github.com/example/repo/pull/${index + 1}`,
                })}
                projectSlug="demo"
              />
            </div>
          )
        )}
      </div>
    ),
  ],
  args: {
    workspace: baseWorkspace,
    projectSlug: 'demo',
  },
};

/** A mocked save keeps the inline name read-only until reconciliation completes. */
export const SlowRename: Story = {
  args: { workspace: baseWorkspace, projectSlug: 'my-project' },
  render: function SlowRenameStory(args) {
    const [workspace, setWorkspace] = useState(args.workspace);
    return (
      <KanbanCard
        {...args}
        workspace={workspace}
        onRename={async (_id, name) => {
          await new Promise<void>((resolve) => setTimeout(resolve, 3000));
          setWorkspace((current) => ({ ...current, name }));
        }}
      />
    );
  },
};
