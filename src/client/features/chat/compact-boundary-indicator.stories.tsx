import type { Meta, StoryObj } from '@storybook/react';
import { expect, within } from 'storybook/test';
import { CompactBoundaryIndicator } from './compact-boundary-indicator';

const meta = {
  title: 'Chat/Transcript/CompactBoundaryIndicator',
  component: CompactBoundaryIndicator,
  parameters: { layout: 'padded' },
  decorators: [
    (Story) => (
      <div className="w-full max-w-2xl p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CompactBoundaryIndicator>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText('Context compacted')).toBeVisible();
    await expect(canvasElement).not.toHaveTextContent('earlier messages');
  },
};

export const Dark: Story = {
  ...Default,
  globals: { theme: 'dark' },
};

export const Phone: Story = {
  ...Default,
  globals: { viewport: { value: 'phone', isRotated: false } },
};
