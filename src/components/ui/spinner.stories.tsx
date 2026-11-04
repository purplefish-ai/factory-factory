import type { Meta, StoryObj } from '@storybook/react';
import { expect, within } from 'storybook/test';
import { Button } from './button';
import { Spinner } from './spinner';

function SpinnerGallery() {
  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner aria-hidden="true" />
        <span>Loading…</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled>
          <Spinner aria-hidden="true" />
          Saving…
        </Button>
        <Button variant="destructive" disabled>
          <Spinner aria-hidden="true" />
          Deleting…
        </Button>
        <Button variant="outline" disabled>
          <Spinner aria-hidden="true" />
          Retrying…
        </Button>
        <Button variant="outline" size="icon" disabled aria-label="Archiving">
          <Spinner aria-hidden="true" />
        </Button>
      </div>
      <Spinner className="size-6 text-muted-foreground" />
    </div>
  );
}

/**
 * Spinners inherit the surrounding text color: muted next to muted text, and the
 * label color inside every button variant.
 */
const meta = {
  title: 'UI/Spinner',
  component: SpinnerGallery,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof SpinnerGallery>;

export default meta;
type Story = StoryObj<typeof meta>;

export const InContext: Story = {
  play: async ({ canvasElement }) => {
    // Only the standalone spinner announces itself; the others sit next to text.
    await expect(within(canvasElement).getAllByRole('status')).toHaveLength(1);
  },
};

export const InContextDark: Story = {
  globals: { theme: 'dark' },
};
