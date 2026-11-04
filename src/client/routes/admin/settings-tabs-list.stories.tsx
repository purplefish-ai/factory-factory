import type { Meta, StoryObj } from '@storybook/react';
import { expect, within } from 'storybook/test';
import { SettingsTabsList } from './settings-tabs-list';

const meta = {
  title: 'Settings/SettingsTabsList',
  component: SettingsTabsList,
  parameters: { layout: 'fullscreen' },
  render: () => (
    <div className="p-3 md:p-6">
      <SettingsTabsList />
    </div>
  ),
} satisfies Meta<typeof SettingsTabsList>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Desktop: Story = {};
export const NarrowMobile: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  decorators: [
    (Story) => (
      <div className="w-[320px] max-w-full">
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'Server logs' })).toHaveAttribute(
      'href',
      '/admin/logs'
    );
    await expect(canvas.getByRole('link', { name: 'Project settings' })).toBeVisible();
    await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth);
  },
};
