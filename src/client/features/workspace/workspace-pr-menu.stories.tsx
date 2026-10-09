import type { Meta, StoryObj } from '@storybook/react-vite';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { WorkspacePullRequest } from '@/shared/workspace-pr';
import { WorkspacePrMenu } from './workspace-pr-menu';

const pr = (
  number: number,
  state: WorkspacePullRequest['state'] = 'OPEN'
): WorkspacePullRequest => ({
  id: `pr-${number}`,
  url: `https://github.com/team/repository/pull/${number}`,
  number,
  title: 'Support multiple pull requests in a workspace with conversation updates',
  headRefName: `feature/workspace-${number}`,
  baseRefName: 'main',
  state,
  reviewState: null,
  ciStatus: 'SUCCESS',
  hasMergeConflict: false,
  syncedAt: null,
});
const meta = {
  title: 'Workspace/Pull requests',
  component: WorkspacePrMenu,
  args: { prs: [], onAdd: () => undefined, onRemove: () => undefined, onReview: () => undefined },
  parameters: { layout: 'centered' },
  decorators: [
    (Story) => (
      <TooltipProvider>
        <Story />
      </TooltipProvider>
    ),
  ],
} satisfies Meta<typeof WorkspacePrMenu>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Empty: Story = {};
export const Single: Story = { args: { prs: [pr(42)] } };
export const Multiple: Story = {
  args: { prs: [{ ...pr(42), ciStatus: 'FAILURE' }, pr(43), pr(44, 'MERGED'), pr(45, 'CLOSED')] },
};
export const Syncing: Story = {
  args: {
    prs: [pr(42, 'MERGED'), { ...pr(43, 'NONE'), number: null, title: null, ciStatus: 'UNKNOWN' }],
  },
};
export const Many: Story = {
  args: { prs: Array.from({ length: 20 }, (_, index) => pr(index + 1)) },
};
export const Mobile: Story = {
  ...Multiple,
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
export const Pending: Story = { ...Multiple, args: { ...Multiple.args, pending: true } };
export const Compact: Story = { ...Multiple, args: { ...Multiple.args, compact: true } };

const monitoring = {
  enabled: true,
  deliveryMode: 'MAIN' as const,
  pending: false,
  onToggle: () => undefined,
  onDeliveryMode: () => undefined,
  onChangeRecipient: () => undefined,
};
export const MainConversation: Story = { args: { prs: [pr(42)], monitoring } };
export const DedicatedConversations: Story = {
  args: { prs: [pr(42), pr(43)], monitoring: { ...monitoring, deliveryMode: 'DEDICATED' } },
};
export const ChangingDestination: Story = {
  args: { prs: [pr(42)], monitoring: { ...monitoring, pending: true } },
};
export const MobileDedicated: Story = {
  ...DedicatedConversations,
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};

export const PausedMainConversation: Story = {
  args: {
    prs: [pr(42)],
    monitoring: { ...monitoring, pauseReason: 'USER_STOPPED', onResume: () => undefined },
  },
};
export const PausedDedicatedConversations: Story = {
  args: {
    prs: [pr(42), pr(43)],
    monitoring: {
      ...monitoring,
      deliveryMode: 'DEDICATED',
      pauseReason: 'SESSION_FAILED',
      onResume: () => undefined,
    },
  },
};
