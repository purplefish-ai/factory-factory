import type { Meta, StoryObj } from '@storybook/react';
import { expect, within } from 'storybook/test';
import {
  IssueRefreshRecoveryFixture,
  exerciseIssueRefreshRecovery,
} from '@/client/components/project-issues-recovery.story-fixtures';
import { STORY_TRPC_PENDING } from '@/client/lib/storybook-trpc';
import { IssueProvider } from '@/shared/core/enums';
import { KanbanBoard } from './kanban-board';
import { handlers, kanbanBoardMeta, workspaces } from './kanban-board.provider.story-fixtures';
import { KanbanProvider } from './kanban-context';

const meta = {
  ...kanbanBoardMeta,
  title: 'Board/KanbanBoardWithData',
} satisfies Meta<typeof KanbanBoard>;
export default meta;
type Story = StoryObj<typeof meta>;

export const IssuesDisconnected: Story = {
  parameters: {
    trpc: {
      handlers: {
        ...handlers,
        'github.listIssuesForProject': () => ({
          issues: [],
          error: 'Project is not linked to a GitHub repository',
        }),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText('Connect an issue provider to see assigned issues')
    ).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Project settings' })).toHaveAttribute(
      'href',
      '/admin/project?project=demo'
    );
  },
};

export const IssuesError: Story = {
  parameters: {
    trpc: {
      handlers: {
        ...handlers,
        'github.listIssuesForProject': () => ({ issues: [], error: 'GitHub is unavailable' }),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(canvas.getByText('Add authentication')).toBeVisible();
  },
};

export const IssuesLoading: Story = {
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole('status', { name: 'Loading issues' })
    ).toBeVisible();
  },
  parameters: {
    trpc: { handlers: { ...handlers, 'github.listIssuesForProject': () => STORY_TRPC_PENDING } },
  },
};

export const NoAssignedIssues: Story = {
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByText('No assigned issues')).toBeVisible();
  },
  parameters: {
    trpc: {
      handlers: { ...handlers, 'github.listIssuesForProject': () => ({ issues: [], error: null }) },
    },
  },
};

export const IssuesRefreshRecovery: Story = {
  // The same project as the meta decorator's header controls.
  render: (_args, { id }) => (
    <IssueRefreshRecoveryFixture
      projectId={`proj-${id}`}
      handlers={{ 'workspace.listForProject': () => ({ workspaces, reviewCount: 0 }) }}
    >
      <KanbanProvider
        projectId={`proj-${id}`}
        projectSlug="demo"
        issueProvider={IssueProvider.GITHUB}
      >
        <div className="h-[640px] p-4">
          <KanbanBoard />
        </div>
      </KanbanProvider>
    </IssueRefreshRecoveryFixture>
  ),
  play: async ({ canvasElement }) => exerciseIssueRefreshRecovery(canvasElement),
};
