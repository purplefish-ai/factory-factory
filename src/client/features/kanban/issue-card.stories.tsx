import type { Meta, StoryObj } from '@storybook/react';
import { expect, within } from 'storybook/test';
import { IssueCard } from './issue-card';

const meta: Meta<typeof IssueCard> = {
  title: 'Board/IssueCard',
  component: IssueCard,
  decorators: [
    (Story) => (
      <div className="w-80">
        <Story />
      </div>
    ),
  ],
  args: {
    projectId: 'preview-project',
    issue: {
      id: 'github-42',
      provider: 'github',
      displayId: '#42',
      title: 'Fix login redirect',
      body: '',
      url: 'https://github.com/acme/repo/issues/42',
      author: 'octocat',
      createdAt: '2026-11-03T12:00:00.000Z',
      githubIssueNumber: 42,
    },
  },
  play: async ({ canvasElement, args }) => {
    const link = within(canvasElement).getByRole('link', {
      name: `Open ${args.issue.displayId} externally`,
    });
    await expect(link).toHaveAttribute('href', args.issue.url);
    await expect(link.textContent).toBe('');
    await expect(link.querySelector('svg')).toBeInTheDocument();
  },
};
export default meta;
type Story = StoryObj<typeof meta>;

export const GitHub: Story = {};

export const Linear: Story = {
  args: {
    issue: {
      id: 'linear-42',
      provider: 'linear',
      displayId: 'ENG-42',
      title: 'Fix login redirect',
      body: '',
      url: 'https://linear.app/acme/issue/ENG-42/fix-login-redirect',
      author: 'linear-user',
      createdAt: '2026-11-03T12:00:00.000Z',
      linearIssueId: 'linear-uuid-42',
      linearIssueIdentifier: 'ENG-42',
    },
  },
};
