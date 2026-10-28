import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { createOptimisticWorkspaceSummary } from '@/client/lib/workspace-summary';
import type { WorkspacePullRequest } from '@/shared/workspace-pr';
import { WorkspaceItemContent } from './workspace-item-content';

const pr: WorkspacePullRequest = {
  id: 'pr-2589',
  url: 'https://github.com/purplefish-ai/factory-factory/pull/2589',
  number: 2589,
  title: 'Warn when the model is not in the catalog',
  headRefName: 'purplefish-ai/when-model-not-catalog-probably-warn',
  baseRefName: 'main',
  state: 'OPEN',
  reviewState: null,
  ciStatus: 'PENDING',
  hasMergeConflict: false,
  syncedAt: null,
};

const meta = {
  title: 'Workspaces/WorkspaceItemContent',
  component: WorkspaceItemContent,
  args: {
    workspace: {
      ...createOptimisticWorkspaceSummary({
        id: 'workspace-pr-layout',
        projectId: 'project',
        name: 'when-model-not-catalog-probably-warn',
        ratchetEnabled: false,
      }),
      branchName: pr.headRefName,
      gitStats: { total: 317, additions: 317, deletions: 0, hasUncommitted: false },
      prs: [pr],
      isWorking: false,
      kanbanColumn: null,
    },
  },
  decorators: [
    (Story) => (
      <div className="w-[300px] max-w-full border p-2">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof WorkspaceItemContent>;

export default meta;
type Story = StoryObj<typeof meta>;

export const PullRequestWithChangeCounts: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const additions = canvas.getByText('+317').getBoundingClientRect();
    const deletions = canvas.getByText('-0').getBoundingClientRect();
    const trigger = canvas.getByRole('button', { name: 'PRs (1)' });
    const triggerBounds = trigger.getBoundingClientRect();
    const branch = canvas.getByText(pr.headRefName!);
    await expect(branch.getBoundingClientRect().right).toBeLessThan(additions.left);
    await expect(additions.right).toBeLessThan(deletions.left);
    await expect(deletions.right).toBeLessThan(triggerBounds.left);
    await expect(triggerBounds.right).toBeLessThanOrEqual(
      canvasElement.getBoundingClientRect().right
    );
    await userEvent.click(trigger);
    const menu = await within(canvasElement.ownerDocument.body).findByRole('menu');
    await waitFor(async () => {
      await expect(menu).toBeVisible();
    });
  },
};

export const MultiplePullRequests: Story = {
  args: {
    workspace: {
      ...meta.args.workspace,
      prs: [pr, { ...pr, id: 'pr-2590', number: 2590, url: pr.url.replace('2589', '2590') }],
    },
  },
};

export const LegacyPullRequest: Story = {
  args: {
    workspace: {
      ...meta.args.workspace,
      prs: [],
      prNumber: 2589,
      prState: 'OPEN',
      prUrl: pr.url,
    },
  },
};
