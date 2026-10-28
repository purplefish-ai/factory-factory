import type { Meta, StoryObj } from '@storybook/react';
import { useEffect } from 'react';
import { trpc } from '@/client/lib/trpc';
import { GitHubPRPreviewCard } from './github-pr-link';
import { MarkdownRenderer } from './markdown';

const data = {
  title: 'docs: record oval bubble detection in the grid lines design',
  state: 'OPEN' as const,
  isDraft: false,
  author: { login: 'martin-purplefish' },
  createdAt: new Date(Date.now() - 52 * 60_000).toISOString(),
  additions: 4,
  deletions: 3,
  changedFiles: 1,
};

const meta = {
  title: 'Chat/GitHub PR preview',
  component: GitHubPRPreviewCard,
  args: { repo: 'purplefish-ai/iron-fillet', number: 12_675, data },
  decorators: [
    (Story) => (
      <div className="w-96 max-w-[calc(100vw-2rem)] rounded-xl border bg-popover p-4 text-popover-foreground shadow-xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof GitHubPRPreviewCard>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {};
export const Draft: Story = { args: { data: { ...data, isDraft: true } } };
export const Merged: Story = { args: { data: { ...data, state: 'MERGED' } } };
export const Closed: Story = { args: { data: { ...data, state: 'CLOSED' } } };
export const MixedCaseRepository: Story = { args: { repo: 'PurpleFish-AI/Iron-Fillet' } };
export const JustCreated: Story = {
  render: (args) => (
    <GitHubPRPreviewCard {...args} data={{ ...data, createdAt: new Date().toISOString() }} />
  ),
};
export const Loading: Story = { args: { data: undefined } };
export const Unavailable: Story = { args: { data: undefined, isError: true } };
export const LongTitle: Story = {
  args: {
    data: {
      ...data,
      title:
        'Preserve workspace pull request monitoring and conversation state when reconnecting after an interrupted background refresh',
      author: null,
      additions: 12_345,
      changedFiles: 247,
    },
  },
};

function HoverExample() {
  const utils = trpc.useUtils();
  useEffect(() => {
    utils.github.getPRPreview.setData({ repo: 'purplefish-ai/iron-fillet', number: 12_675 }, data);
  }, [utils]);
  return (
    <MarkdownRenderer content="[#12675](https://github.com/purplefish-ai/iron-fillet/pull/12675) is ready for review. Hover or focus the link to preview it." />
  );
}

export const HoverPreview: Story = {
  decorators: [],
  render: () => (
    <div className="max-w-xl p-10">
      <HoverExample />
    </div>
  ),
};
