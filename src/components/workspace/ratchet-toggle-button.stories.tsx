import type { Meta, StoryObj } from '@storybook/react';
import { RatchetToggleButton } from './ratchet-toggle-button';

const meta = {
  title: 'Workspace/RatchetToggleButton',
  component: RatchetToggleButton,
  parameters: {
    layout: 'centered',
  },
  args: {
    onToggle: () => undefined,
    disabled: false,
  },
  tags: ['autodocs'],
} satisfies Meta<typeof RatchetToggleButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Off: Story = {
  args: {
    enabled: false,
    state: 'IDLE',
  },
};

export const OnIdle: Story = {
  args: {
    enabled: true,
    state: 'READY',
  },
};

export const OnProcessing: Story = {
  args: {
    enabled: true,
    state: 'CI_FAILED',
  },
};
