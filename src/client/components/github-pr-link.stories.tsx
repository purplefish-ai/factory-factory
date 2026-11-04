import type { Meta, StoryObj } from '@storybook/react';
import { INITIAL_VIEWPORTS } from 'storybook/viewport';
import { GitHubPreviewTooltip } from './github-link-preview';
import { GitHubPRPreviewCard } from './github-pr-link';

const data = {
  title: 'docs: record oval bubble detection in the grid lines design',
  state: 'OPEN' as const,
  isDraft: false,
  author: { login: 'martin-purplefish' },
  // Relative-time labels intentionally follow the clock when the story opens.
  createdAt: new Date(Date.now() - 52 * 60_000).toISOString(),
  additions: 4,
  deletions: 3,
  changedFiles: 1,
};

const meta = {
  title: 'Chat/Transcript/GitHubPRLink',
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
  return (
    <GitHubPreviewTooltip
      link={
        <a
          href="https://github.com/purplefish-ai/iron-fillet/pull/12675"
          target="_blank"
          rel="noreferrer"
        >
          #12675
        </a>
      }
    >
      <GitHubPRPreviewCard repo="purplefish-ai/iron-fillet" number={12_675} data={data} />
    </GitHubPreviewTooltip>
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

export const Mobile: Story = {
  ...LongTitle,
  parameters: { viewport: { options: INITIAL_VIEWPORTS } },
  globals: { viewport: { value: 'iphonex', isRotated: false } },
};

export const AllStatesDark: Story = {
  globals: { theme: 'dark' },
  render: (args) => {
    // Derive every state from the story's data so control edits apply to all.
    const base = args.data ?? data;
    return (
      <div className="grid gap-4">
        <GitHubPRPreviewCard {...args} data={base} />
        <GitHubPRPreviewCard {...args} data={{ ...base, isDraft: true }} />
        <GitHubPRPreviewCard {...args} data={{ ...base, state: 'MERGED' }} />
        <GitHubPRPreviewCard {...args} data={{ ...base, state: 'CLOSED' }} />
      </div>
    );
  },
};
