import type { Meta, StoryObj } from '@storybook/react';
import { Toaster } from 'sonner';
import { expect, userEvent, within } from 'storybook/test';
import { runInBackground } from '@/client/lib/background-task';
import { Button } from '@/components/ui/button';

function BackgroundRefreshExample() {
  const refresh = (message: string) => {
    runInBackground(Promise.reject(new Error(message)), 'Could not refresh data');
  };
  return (
    <div className="flex gap-2 p-4">
      <Button onClick={() => refresh('Network unavailable')}>Refresh</Button>
      <Button onClick={() => refresh('Still offline')}>Retry refresh</Button>
      <Toaster />
    </div>
  );
}

const meta = {
  title: 'Components/Background errors',
  component: BackgroundRefreshExample,
} satisfies Meta<typeof BackgroundRefreshExample>;
export default meta;
type Story = StoryObj<typeof meta>;

export const RepeatedRefreshFailure: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /^Refresh$/ }));
    await expect(await canvas.findByText('Network unavailable')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Retry refresh' }));
    await expect(await canvas.findByText('Still offline')).toBeVisible();
    await expect(canvas.getAllByText('Could not refresh data')).toHaveLength(1);
  },
};
