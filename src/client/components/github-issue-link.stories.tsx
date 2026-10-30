import type { Meta, StoryObj } from '@storybook/react';
import { useEffect } from 'react';
import { trpc } from '@/client/lib/trpc';
import { GitHubIssuePreviewCard } from './github-issue-link';
import { MarkdownRenderer } from './markdown';

const data = {
  title: 'Show GitHub issue previews in conversations',
  state: 'OPEN' as const,
  author: { login: 'martin-purplefish' },
  createdAt: new Date(Date.now() - 52 * 60_000).toISOString(),
};

const meta = {
  title: 'Chat/GitHub issue preview',
  component: GitHubIssuePreviewCard,
  args: { repo: 'purplefish-ai/iron-fillet', number: 12_675, data },
  decorators: [
    (Story) => (
      <div className="w-96 max-w-[calc(100vw-2rem)] rounded-xl border bg-popover p-4 text-popover-foreground shadow-xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof GitHubIssuePreviewCard>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {};
export const Closed: Story = { args: { data: { ...data, state: 'CLOSED' } } };
export const MixedCaseRepository: Story = { args: { repo: 'PurpleFish-AI/Iron-Fillet' } };
export const JustCreated: Story = {
  render: (args) => (
    <GitHubIssuePreviewCard {...args} data={{ ...data, createdAt: new Date().toISOString() }} />
  ),
};
export const Loading: Story = { args: { data: undefined } };
export const Unavailable: Story = { args: { data: undefined, isError: true } };
export const LongTitle: Story = {
  args: {
    data: {
      ...data,
      title:
        'Preserve workspace issue monitoring and conversation state when reconnecting after an interrupted background refresh',
      author: null,
    },
  },
};

function HoverExample() {
  const utils = trpc.useUtils();
  useEffect(() => {
    utils.github.getIssuePreview.setData(
      { repo: 'purplefish-ai/iron-fillet', number: 12_675 },
      data
    );
  }, [utils]);
  return (
    <MarkdownRenderer content="[#12675](https://github.com/purplefish-ai/iron-fillet/issues/12675) is open. Hover or focus the link to preview it." />
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
