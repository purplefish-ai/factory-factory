import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { PRDeliveryMode } from '@/shared/pr-monitoring';
import { PRMonitoringMenuItems } from './pr-monitoring-menu-items';

const meta = {
  title: 'Workspace/PRMonitoringMenuItems',
  component: PRMonitoringMenuItems,
  parameters: { layout: 'centered' },
  args: {
    enabled: false,
    deliveryMode: PRDeliveryMode.MAIN,
    pending: true,
    onToggle: fn(),
    onDeliveryMode: fn(),
    onChangeRecipient: fn(),
  },
  decorators: [
    (Story) => (
      <DropdownMenu open modal={false}>
        <DropdownMenuTrigger asChild>
          <Button>PR updates</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <Story />
        </DropdownMenuContent>
      </DropdownMenu>
    ),
  ],
} satisfies Meta<typeof PRMonitoringMenuItems>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Saving: Story = {
  play: async ({ canvasElement }) => {
    const item = within(canvasElement.ownerDocument.body).getByRole('menuitem', {
      name: 'Turn on PR updates',
    });
    await expect(item).toHaveAttribute('aria-disabled', 'true');
    await expect(item).toHaveAttribute('aria-busy', 'true');
    // The spinner replaces the wrench while the toggle is in flight.
    await expect(item.querySelector('[data-slot=spinner]')).not.toBeNull();
    await expect(item.querySelector('[data-ratchet-state]')).toBeNull();
  },
};
export const SavingDark: Story = { ...Saving, globals: { theme: 'dark' } };
export const DeliveryBlocked: Story = {
  args: {
    enabled: true,
    pending: false,
    pauseReason: 'DELIVERY_BLOCKED',
    onResume: fn(),
    onDiscardBlocked: fn(),
  },
  play: async ({ args, canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await expect(body.getByRole('status')).toHaveTextContent('PR updates are stopped');
    await expect(body.queryByRole('menuitem', { name: 'Resume PR updates' })).toBeNull();
    await userEvent.click(body.getByRole('menuitem', { name: 'Discard stuck PR update…' }));
    await expect(args.onDiscardBlocked).toHaveBeenCalledOnce();
  },
};
export const DeliveryBlockedDark: Story = { ...DeliveryBlocked, globals: { theme: 'dark' } };
