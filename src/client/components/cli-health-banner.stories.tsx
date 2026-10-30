import type { Meta, StoryObj } from '@storybook/react';
import { useArgs } from 'storybook/preview-api';
import { expect, fn, userEvent, within } from 'storybook/test';
import { CLIHealthBannerContent, collectIssues } from './cli-health-banner';

const health = {
  claude: {
    isInstalled: true,
    isOutdated: true,
    version: '2.1.310',
    latestVersion: '2.1.312',
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
    isUpgrading: false,
    onRecheck: fn(),
    onDismiss: fn(),
    onUpgrade: fn(),
  },
} satisfies Meta<typeof CLIHealthBannerContent>;

export default meta;
type Story = StoryObj<typeof meta>;

export const UpdateAvailable: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole('alert')).not.toBeInTheDocument();
    await expect(canvas.queryByRole('link')).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Update Claude' }));
    await expect(args.onUpgrade).toHaveBeenCalledWith('CLAUDE');
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

export const UpdateAndWarning: Story = {
  args: {
    issues: collectIssues({ ...health, github: { isInstalled: true, isAuthenticated: false } }),
  },
};

export const UpdateCompleted: Story = {
  args: UpdateAndWarning.args,
  render: function UpdateCompletedRender(args) {
    const [, updateArgs] = useArgs();
    return (
      <CLIHealthBannerContent
        {...args}
        onUpgrade={(provider) => {
          args.onUpgrade(provider);
          updateArgs({
            issues: collectIssues({
              ...health,
              claude: { ...health.claude, version: health.claude.latestVersion, isOutdated: false },
              github: { isInstalled: true, isAuthenticated: false },
            }),
          });
        }}
      />
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Update Claude' }));
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

export const Updating: Story = {
  args: { isUpgrading: true },
};

export const Rechecking: Story = {
  args: { ...SignInRequired.args, isRefetching: true },
};

export const Healthy: Story = {
  args: { issues: [] },
};
