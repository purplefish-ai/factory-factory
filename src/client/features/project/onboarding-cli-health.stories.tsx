import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, within } from 'storybook/test';
import { OnboardingCliHealth } from './onboarding-cli-health';

const meta = {
  title: 'Projects/OnboardingCliHealth',
  component: OnboardingCliHealth,
  args: { onOpenTerminal: fn() },
  parameters: {
    trpc: {
      handlers: {
        'admin.checkCLIHealth': () => ({
          claude: { isInstalled: true, isAuthenticated: true },
          codex: {
            isInstalled: false,
            isAuthenticated: false,
            error:
              'Please try again in a few moments. If this continues, try restarting Factory Factory.',
          },
          github: { isInstalled: true, isAuthenticated: true },
          allHealthy: true,
        }),
      },
    },
  },
} satisfies Meta<typeof OnboardingCliHealth>;
export default meta;
type Story = StoryObj<typeof meta>;
/** A failed check reads as an error with Retry, not as a passed check. */
export const CheckFailed: Story = {
  parameters: {
    trpc: {
      handlers: {
        'admin.checkCLIHealth': () => {
          throw new Error('Backend unavailable');
        },
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const alert = await canvas.findByRole('alert');
    await expect(alert).toHaveTextContent("Couldn't check CLI prerequisites");
    await expect(within(alert).getByRole('button', { name: 'Retry' })).toBeVisible();
  },
};

export const TemporaryRuntimeFailure: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(/Please try again in a few moments/)).toBeVisible();
    await expect(canvas.queryByText(/update Factory Factory/)).not.toBeInTheDocument();
  },
};
