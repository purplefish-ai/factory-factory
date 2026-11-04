import type { Meta, StoryObj } from '@storybook/react';
import { expect, within } from 'storybook/test';
import { ProviderCliWarning } from './provider-cli-warning';

const meta = {
  title: 'Shared/ProviderCliWarning',
  component: ProviderCliWarning,
  args: { provider: 'CODEX' },
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
        'codexAccounts.list': () => [],
      },
    },
  },
} satisfies Meta<typeof ProviderCliWarning>;
export default meta;
type Story = StoryObj<typeof meta>;
export const TemporaryRuntimeFailure: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(/Please try again in a few moments/)).toBeVisible();
    await expect(canvas.queryByText(/reinstall/)).not.toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: 'Recheck' })).toBeVisible();
  },
};
