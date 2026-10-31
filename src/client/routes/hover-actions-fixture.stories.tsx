import type { Meta, StoryObj } from '@storybook/react';
import { HoverActionsFixture } from './hover-actions-fixture';

const meta = {
  title: 'Responsive/HoverActions',
  component: HoverActionsFixture,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof HoverActionsFixture>;
export default meta;
type Story = StoryObj<typeof meta>;

export const TouchActions: Story = {};
