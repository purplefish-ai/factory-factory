import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { CLIHealthBannerContent, collectIssues } from './cli-health-banner';

const health = {
  claude: {
    isInstalled: true,
    isAuthenticated: false,
  },
  codex: { isInstalled: true, isAuthenticated: true },
  github: { isInstalled: true, isAuthenticated: true },
};

const meta = {
  title: 'Components/CLIHealthBanner',
  component: CLIHealthBannerContent,
  parameters: { layout: 'fullscreen' },
  args: {
    issues: collectIssues(health),
    isRefetching: false,
    onRecheck: fn(),
    onDismiss: fn(),
  },
} satisfies Meta<typeof CLIHealthBannerContent>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ClaudeSignInRequired: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('alert')).toHaveTextContent('setup terminal in Settings');
    await expect(canvas.getByRole('alert')).toHaveTextContent('If ff is installed');
    await expect(canvas.queryByRole('link')).not.toBeInTheDocument();
    await expect(canvas.queryByRole('button', { name: 'Update Claude' })).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Recheck' }));
    await expect(args.onRecheck).toHaveBeenCalled();
    await userEvent.click(canvas.getByRole('button', { name: 'Dismiss' }));
    await expect(args.onDismiss).toHaveBeenCalled();
  },
};

export const SignInRequired: Story = {
  args: {
    issues: collectIssues({
      ...health,
      claude: { isInstalled: true },
      github: { isInstalled: true, isAuthenticated: false },
    }),
  },
};

export const ClaudeAndGitHubSignIn: Story = {
  args: {
    issues: collectIssues({ ...health, github: { isInstalled: true, isAuthenticated: false } }),
  },
};

export const ManagedRuntimeIgnoresStaleVersion: Story = {
  args: {
    issues: collectIssues({
      ...health,
      claude: {
        isInstalled: true,
        isAuthenticated: true,
        version: '2.1.310',
        latestVersion: '2.1.312',
        isOutdated: true,
      },
      github: { isInstalled: true, isAuthenticated: false },
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole('button', { name: 'Update Claude' })).not.toBeInTheDocument();
    await expect(canvas.getByRole('alert')).toHaveTextContent('GitHub sign-in required');
  },
};

export const MissingTools: Story = {
  args: {
    issues: collectIssues({
      ...health,
      claude: { isInstalled: false },
      github: { isInstalled: false, isAuthenticated: false },
    }),
  },
};

export const Rechecking: Story = {
  args: { ...SignInRequired.args, isRefetching: true },
};

export const Healthy: Story = {
  args: { issues: [] },
};
