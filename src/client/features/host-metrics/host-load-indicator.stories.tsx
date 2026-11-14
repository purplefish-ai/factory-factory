import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent, within } from 'storybook/test';
import { HostLoadIndicatorView } from './host-load-indicator';
import { hostLoadBreakdown, hostLoadHistory as history } from './host-load.story-fixtures';

const meta: Meta<typeof HostLoadIndicatorView> = {
  title: 'Navigation/HostLoadIndicator',
  component: HostLoadIndicatorView,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  args: { samples: history(18, 45), compact: false, breakdown: hostLoadBreakdown },
};
export default meta;
type Story = StoryObj<typeof meta>;

export const Calm: Story = {};

const GALLERY_STATES = [
  ['Calm', history(7, 62)],
  ['Busy CPU', history(86, 45)],
  ['Memory exhausted', history(30, 97)],
  ['Both pegged', history(99, 96)],
] as const;

/** Every load level at desktop and phone size. */
export const Gallery: Story = {
  render: () => (
    <div className="grid grid-cols-[auto_repeat(2,auto)] items-center gap-x-6 gap-y-3 text-xs">
      <span />
      {['Desktop', 'Phone'].map((title) => (
        <span key={title} className="text-muted-foreground">
          {title}
        </span>
      ))}
      {GALLERY_STATES.map(([name, samples]) => (
        <div key={name} className="contents">
          <span className="text-muted-foreground">{name}</span>
          <HostLoadIndicatorView samples={samples} compact={false} breakdown={hostLoadBreakdown} />
          <HostLoadIndicatorView samples={samples} compact breakdown={hostLoadBreakdown} />
        </div>
      ))}
    </div>
  ),
};

export const JustStarted: Story = { args: { samples: history(18, 45, 2) } };

export const BusyCpu: Story = { args: { samples: history(86, 45) } };

export const MemoryExhausted: Story = { args: { samples: history(30, 97) } };

export const Details: Story = {
  args: { samples: history(86, 45) },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: /Computer load/ }));
    const body = within(canvasElement.ownerDocument.body);
    await expect(await body.findByText('Memory')).toBeInTheDocument();
    await expect(await body.findByText('Using the most CPU')).toBeInTheDocument();
  },
};

export const Phone: Story = {
  args: { compact: true },
  globals: { viewport: { value: 'phone', isRotated: false } },
};

export const PhoneOverloaded: Story = {
  args: { compact: true, samples: history(30, 97) },
  globals: { viewport: { value: 'phone', isRotated: false } },
};

export const PhoneDetails: Story = {
  args: { compact: true, samples: history(86, 45) },
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: Details.play,
};
