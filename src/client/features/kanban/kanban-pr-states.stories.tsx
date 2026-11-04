import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent, within } from 'storybook/test';
import type { PRState } from '@/shared/core';
import type { WorkspacePullRequest } from '@/shared/workspace-pr';
import { KanbanPrStates } from './kanban-pr-states';

function pr(state: PRState, number: number): WorkspacePullRequest {
  return {
    id: String(number),
    number,
    state,
    url: `https://github.com/example/repo/pull/${number}`,
    title: null,
    headRefName: null,
    baseRefName: 'main',
    reviewState: null,
    ciStatus: 'UNKNOWN',
    hasMergeConflict: false,
    syncedAt: null,
  };
}
const meta = {
  title: 'Board/KanbanPrStates',
  component: KanbanPrStates,
  decorators: [
    (Story) => (
      <div className="flex items-center gap-2 p-4">
        <Story />
      </div>
    ),
  ],
  args: { prs: [pr('OPEN', 1), pr('OPEN', 2), pr('MERGED', 3), pr('DRAFT', 4)] },
} satisfies Meta<typeof KanbanPrStates>;
export default meta;
type Story = StoryObj<typeof meta>;
export const MultiplePRs: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const open = canvas.getByRole('button', { name: '#1, #2: Open' });
    await expect(open).toHaveTextContent('2');
    open.focus();
    await expect(await within(document.body).findByRole('tooltip')).toHaveTextContent(
      '#1, #2: Open'
    );
    await userEvent.tab();
    await expect(canvas.getByRole('button', { name: '#3: Merged' })).toHaveFocus();
  },
};
export const AllStates: Story = {
  args: {
    prs: (
      ['NONE', 'DRAFT', 'OPEN', 'APPROVED', 'CHANGES_REQUESTED', 'MERGED', 'CLOSED'] as const
    ).map((state, i) => pr(state, i + 1)),
  },
};
export const MultiplePRsDark: Story = { ...MultiplePRs, globals: { theme: 'dark' } };
