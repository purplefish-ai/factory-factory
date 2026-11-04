import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, within } from 'storybook/test';
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
    await expect(
      within(canvasElement.ownerDocument.body).getByRole('menuitem', { name: 'Turn on PR updates' })
    ).toHaveAttribute('aria-disabled', 'true');
  },
};
export const SavingDark: Story = { ...Saving, globals: { theme: 'dark' } };
