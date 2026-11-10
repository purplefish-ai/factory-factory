import type { Meta, StoryObj } from '@storybook/react';
import { expect, waitFor, within } from 'storybook/test';
import { readStorageItem, removeStorageItem } from '@/client/lib/browser-storage';
import TranscriptScrollFixture from './transcript-scroll-fixture';

const meta: Meta<typeof TranscriptScrollFixture> = {
  title: 'Chat/Transcript/ScrollBursts',
  component: TranscriptScrollFixture,
  parameters: { layout: 'fullscreen' },
  beforeEach: () => {
    removeStorageItem('workspace-panel-scroll-fixture-W1');
  },
};
export default meta;
type Story = StoryObj<typeof meta>;

export const WindowTrimming: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const viewport = canvas.getByTestId('transcript-viewport');
    const gap = () => viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
    await waitFor(() => expect(gap()).toBeLessThanOrEqual(1));
    for (let i = 0; i < 30; i++) {
      canvas.getByRole('button', { name: 'Tool burst' }).click();
      canvas.getByRole('button', { name: 'Toggle activity' }).click();
      await new Promise(requestAnimationFrame);
      canvas.getByRole('button', { name: 'Append burst' }).click();
      await new Promise(requestAnimationFrame);
      canvas.getByRole('button', { name: 'Trim window' }).click();
      await new Promise(requestAnimationFrame);
      await expect(readStorageItem('workspace-panel-scroll-fixture-W1') ?? '').not.toContain(
        '"intent":"reading"'
      );
    }
    await waitFor(() => expect(gap()).toBeLessThanOrEqual(1));
    await expect(canvas.queryByRole('button', { name: 'Scroll to bottom' })).toBeNull();
  },
};

export const PhoneWindowTrimming: Story = {
  ...WindowTrimming,
  globals: { viewport: { value: 'phone', isRotated: false } },
};
