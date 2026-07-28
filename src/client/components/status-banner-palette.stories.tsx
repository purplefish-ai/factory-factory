import { InfoIcon, WarningIcon } from '@phosphor-icons/react';
import type { Meta, StoryObj } from '@storybook/react';
import { getStatusBannerClassName } from '@/client/lib/status-banner-styles';
import type { WorkspaceInitBanner } from '@/shared/workspace-init';

const BANNERS: Pick<WorkspaceInitBanner, 'kind' | 'message'>[] = [
  { kind: 'error', message: 'Agent failed to start.' },
  { kind: 'warning', message: 'Workspace setup completed with warnings.' },
  { kind: 'info', message: 'Workspace setup is still running.' },
];

function StatusBannerPalette() {
  return (
    <div className="w-[32rem] space-y-3 bg-background p-6 text-foreground">
      {BANNERS.map((banner) => {
        const Icon = banner.kind === 'info' ? InfoIcon : WarningIcon;
        return (
          <div
            key={banner.kind}
            className={[
              'flex items-start gap-3 rounded-md border p-3 text-sm',
              getStatusBannerClassName(banner.kind),
            ].join(' ')}
          >
            <Icon className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-medium capitalize">{banner.kind}</p>
              <p>{banner.message}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

const meta = {
  title: 'Components/StatusBannerPalette',
  component: StatusBannerPalette,
  parameters: {
    layout: 'centered',
  },
} satisfies Meta<typeof StatusBannerPalette>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AllStates: Story = {};
