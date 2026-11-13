import { XIcon } from '@phosphor-icons/react/dist/csr/X';
import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { getStatusToneStyle, STATUS_TONES } from '@/client/lib/status-tones';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { StatusCallout } from './status-callout';

const meta = {
  title: 'Shared/StatusCallout',
  component: StatusCallout,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
  args: {
    tone: 'warning',
    children: 'This workspace has 2 active child workspaces. Archiving will not archive them.',
  },
  decorators: [
    (Story) => (
      <div className="max-w-xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof StatusCallout>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** Every tone as a card and a strip, at both sizes. */
export const AllTones: Story = {
  render: () => (
    <div className="space-y-4">
      {STATUS_TONES.map((tone) => (
        <div key={tone} className="space-y-2">
          <StatusCallout tone={tone} title={`${getStatusToneStyle(tone).name} title`}>
            Card with a title and a message under it.
          </StatusCallout>
          <div className="overflow-hidden rounded-md border bg-card">
            <StatusCallout tone={tone} variant="strip" size="sm">
              {getStatusToneStyle(tone).name} strip at the top of a panel.
            </StatusCallout>
            <p className="p-3 text-sm">Panel content</p>
          </div>
        </div>
      ))}
    </div>
  ),
};

export const AllTonesDark: Story = {
  ...AllTones,
  globals: { theme: 'dark' },
};

const onRetry = fn();

/** A failure with a title, detail and a trailing Retry action. */
export const WithAction: Story = {
  args: {
    tone: 'danger',
    role: 'alert',
    title: 'Transcript update failed',
    children: 'Network unavailable',
    action: (
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    ),
  },
  beforeEach: () => {
    onRetry.mockClear();
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('alert')).toHaveTextContent('Transcript update failed');
    await userEvent.click(canvas.getByRole('button', { name: 'Retry' }));
    await expect(onRetry).toHaveBeenCalledOnce();
  },
};

/** Live work replaces the tone icon with the shared spinner. */
export const WithSpinner: Story = {
  args: {
    tone: 'info',
    icon: <Spinner aria-hidden="true" />,
    children: 'Workspace setup is still running.',
  },
};

/** On a phone the action moves under the message instead of squeezing it. */
export const Phone: Story = {
  args: {
    tone: 'danger',
    variant: 'strip',
    children:
      'Init script failed: pnpm install exited with code 1 because the lockfile did not match.',
    action: (
      <>
        <Button type="button" variant="ghost" size="sm">
          Show output
        </Button>
        <Button type="button" variant="outline" size="sm">
          Retry
        </Button>
      </>
    ),
  },
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ({ canvasElement }) => {
    const callout = canvasElement.querySelector('[data-slot="status-callout"]');
    const message = callout?.children[1];
    const action = callout?.children[2];
    await expect(message).toBeTruthy();
    await expect(action).toBeTruthy();
    if (message && action) {
      // Wrapped: the action row starts below the message.
      await expect(action.getBoundingClientRect().top).toBeGreaterThanOrEqual(
        message.getBoundingClientRect().bottom
      );
    }
  },
};

/** Exercise actual button heights: fixed negative offsets cannot align all three. */
export const ActionAlignment: Story = {
  render: () => (
    <div className="space-y-3">
      {(['card', 'strip'] as const).flatMap((variant) =>
        (['sm', 'md'] as const).flatMap((size) =>
          (['xs', 'compact', 'sm'] as const).map((buttonSize) => (
            <StatusCallout
              key={`${variant}-${size}-${buttonSize}`}
              tone="danger"
              variant={variant}
              size={size}
              action={
                <>
                  <Button variant="outline" size={buttonSize}>
                    Retry
                  </Button>
                  <Button variant="ghost" size="icon-xs" aria-label="Dismiss">
                    <XIcon />
                  </Button>
                </>
              }
            >
              Init script failed: no free slot available
            </StatusCallout>
          ))
        )
      )}
    </div>
  ),
  play: async ({ canvasElement }) => {
    const center = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return rect.top + rect.height / 2;
    };
    for (const callout of canvasElement.querySelectorAll('[data-slot="status-callout"]')) {
      const [icon, message, action] = Array.from(callout.children);
      if (!(icon && message && action)) {
        throw new Error('Expected an icon, message and actions');
      }
      await expect(Math.abs(center(icon) - center(message))).toBeLessThanOrEqual(1);
      await expect(Math.abs(center(action) - center(message))).toBeLessThanOrEqual(1);
      for (const button of action.querySelectorAll('button')) {
        await expect(Math.abs(center(button) - center(message))).toBeLessThanOrEqual(1);
        await expect(button.getBoundingClientRect().top).toBeGreaterThan(
          callout.getBoundingClientRect().top
        );
        await expect(button.getBoundingClientRect().bottom).toBeLessThan(
          callout.getBoundingClientRect().bottom
        );
      }
    }
  },
};

export const ActionAlignmentDark: Story = {
  ...ActionAlignment,
  globals: { theme: 'dark' },
};
