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
  title: 'Support multiple pull requests in a workspace with independent automation',
  headRefName: `feature/workspace-${number}`,
  baseRefName: 'main',
  state,
  reviewState: null,
  ciStatus: 'SUCCESS',
  hasMergeConflict: false,
  syncedAt: null,
  ratchet: {
    lastCheckedAt: null,
    dispatchOutcome: null,
    dispatchRetryCount: 0,
    dispatchStalled: false,
  },
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
