import type { Meta, StoryObj } from '@storybook/react';
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
      <div className="w-[280px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof KanbanCard>;

export default meta;
type Story = StoryObj<typeof meta>;

const baseWorkspace: WorkspaceWithKanban = {
  id: 'ws-1',
  name: 'Add user authentication',
  description: 'Implement OAuth2 login flow',
  branchName: 'feature/auth',
  projectId: 'proj-1',
  worktreePath: '/path/to/worktree',
  prUrl: null,
  prNumber: null,
  prState: 'NONE',
  prReviewState: null,
  prCiStatus: 'UNKNOWN',
  prUpdatedAt: null,
  status: 'READY',
  createdAt: new Date(),
  updatedAt: new Date(),
  kanbanColumn: 'IN_PROGRESS',
  isWorking: false,
  errorMessage: null,
  provisioningStartedAt: null,
  provisioningCompletedAt: null,
  retryCount: 0,
  githubIssueNumber: null,
  githubIssueUrl: null,
  hasHadSessions: true,
  cachedKanbanColumn: 'IN_PROGRESS',
  stateComputedAt: new Date(),
  runScriptCommand: null,
  runScriptCleanupCommand: null,
  runScriptPid: null,
  runScriptPort: null,
  runScriptStartedAt: null,
  runScriptStatus: 'IDLE',
};

export const NoPR: Story = {
  args: {
    workspace: baseWorkspace,
    projectSlug: 'my-project',
  },
};

export const DraftPR: Story = {
  args: {
    workspace: {
      ...baseWorkspace,
      prUrl: 'https://github.com/example/repo/pull/42',
      prNumber: 42,
      prState: 'DRAFT',
    },
    projectSlug: 'my-project',
  },
};

export const OpenPR: Story = {
  args: {
    workspace: {
      ...baseWorkspace,
      prUrl: 'https://github.com/example/repo/pull/43',
      prNumber: 43,
      prState: 'OPEN',
      prCiStatus: 'PENDING',
    },
    projectSlug: 'my-project',
  },
};

export const ChangesRequested: Story = {
  args: {
    workspace: {
      ...baseWorkspace,
      name: 'Fix login validation',
      prUrl: 'https://github.com/example/repo/pull/44',
      prNumber: 44,
      prState: 'CHANGES_REQUESTED',
      prCiStatus: 'SUCCESS',
    },
    projectSlug: 'my-project',
  },
};

export const Approved: Story = {
  args: {
    workspace: {
      ...baseWorkspace,
      name: 'Add password reset flow',
      prUrl: 'https://github.com/example/repo/pull/45',
      prNumber: 45,
      prState: 'APPROVED',
      prCiStatus: 'SUCCESS',
    },
    projectSlug: 'my-project',
  },
};

export const Merged: Story = {
  args: {
    workspace: {
      ...baseWorkspace,
      name: 'Implement MFA support',
      prUrl: 'https://github.com/example/repo/pull/46',
      prNumber: 46,
      prState: 'MERGED',
      kanbanColumn: 'MERGED',
    },
    projectSlug: 'my-project',
  },
};

export const Closed: Story = {
  args: {
    workspace: {
      ...baseWorkspace,
      name: 'Deprecated feature branch',
      prUrl: 'https://github.com/example/repo/pull/47',
      prNumber: 47,
      prState: 'CLOSED',
      kanbanColumn: 'DONE',
    },
    projectSlug: 'my-project',
  },
};

export const Working: Story = {
  args: {
    workspace: {
      ...baseWorkspace,
      name: 'Active coding session',
      isWorking: true,
      prState: 'OPEN',
      prUrl: 'https://github.com/example/repo/pull/48',
      prNumber: 48,
    },
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

export const AllPRStates: Story = {
  decorators: [
    () => (
      <div className="flex flex-wrap gap-4">
        <div className="w-[280px]">
          <KanbanCard
            workspace={{ ...baseWorkspace, prState: 'DRAFT', prNumber: 1, prUrl: '#' }}
            projectSlug="demo"
          />
        </div>
        <div className="w-[280px]">
          <KanbanCard
            workspace={{ ...baseWorkspace, prState: 'OPEN', prNumber: 2, prUrl: '#' }}
            projectSlug="demo"
          />
        </div>
        <div className="w-[280px]">
          <KanbanCard
            workspace={{
              ...baseWorkspace,
              prState: 'CHANGES_REQUESTED',
              prNumber: 3,
              prUrl: '#',
            }}
            projectSlug="demo"
          />
        </div>
        <div className="w-[280px]">
          <KanbanCard
            workspace={{ ...baseWorkspace, prState: 'APPROVED', prNumber: 4, prUrl: '#' }}
            projectSlug="demo"
          />
        </div>
        <div className="w-[280px]">
          <KanbanCard
            workspace={{ ...baseWorkspace, prState: 'MERGED', prNumber: 5, prUrl: '#' }}
            projectSlug="demo"
          />
        </div>
        <div className="w-[280px]">
          <KanbanCard
            workspace={{ ...baseWorkspace, prState: 'CLOSED', prNumber: 6, prUrl: '#' }}
            projectSlug="demo"
          />
        </div>
      </div>
    ),
  ],
  args: {
    workspace: baseWorkspace,
    projectSlug: 'demo',
  },
};
