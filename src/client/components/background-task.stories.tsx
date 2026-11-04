import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { runInBackground } from '@/client/lib/background-task';
import { Button } from '@/components/ui/button';

function BackgroundRefreshExample() {
  const refresh = (message: string) => {
    runInBackground(Promise.reject(new Error(message)), "Couldn't refresh data");
  };
  return (
    <div className="flex gap-2 p-4">
      <Button onClick={() => refresh('Network unavailable')}>Refresh</Button>
      <Button onClick={() => refresh('Still offline')}>Retry refresh</Button>
    </div>
  );
}

const meta = {
  title: 'Shared/BackgroundTask',
  component: BackgroundRefreshExample,
} satisfies Meta<typeof BackgroundRefreshExample>;
export default meta;
type Story = StoryObj<typeof meta>;

export const RepeatedRefreshFailure: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /^Refresh$/ }));
    // Toasts fade in, so wait for them to become visible. The app Toaster comes
    // from .storybook/preview.ts.
    const first = await canvas.findByText('Network unavailable');
    await waitFor(() => expect(first).toBeVisible());
    await userEvent.click(canvas.getByRole('button', { name: 'Retry refresh' }));
    const second = await canvas.findByText('Still offline');
    await waitFor(() => expect(second).toBeVisible());
    await expect(canvas.getAllByText("Couldn't refresh data")).toHaveLength(1);
  },
};
