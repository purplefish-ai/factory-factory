import type { Meta, StoryObj } from '@storybook/react';
import { expect, within } from 'storybook/test';
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

/** The name stays "PR updates" in both states; `aria-pressed` says on or off. */
function expectPressed(canvasElement: HTMLElement, pressed: boolean) {
  return expect(within(canvasElement).getByRole('button', { name: 'PR updates' })).toHaveAttribute(
    'aria-pressed',
    String(pressed)
  );
}

export const Off: Story = {
  args: {
    enabled: false,
    state: 'IDLE',
  },
  play: async ({ canvasElement }) => {
    await expectPressed(canvasElement, false);
  },
};

export const OnIdle: Story = {
  args: {
    enabled: true,
    state: 'READY',
  },
  play: async ({ canvasElement }) => {
    await expectPressed(canvasElement, true);
  },
};

export const Pending: Story = {
  args: {
    enabled: false,
    state: 'IDLE',
    pending: true,
  },
};

export const OnProcessing: Story = {
  args: {
    enabled: true,
    state: 'CI_FAILED',
    animated: true,
  },
};

/** The workspace settings popover shows the state as text beside its "PR updates" row. */
export const Labeled: Story = {
  args: { enabled: true, state: 'IDLE', label: 'On' },
  play: async ({ canvasElement }) => {
    await expectPressed(canvasElement, true);
  },
};
