import type { Meta, StoryObj } from '@storybook/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { useState } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { trpc } from '@/client/lib/trpc';
import { VoiceModeToggle } from './voice-mode-toggle';

const meta: Meta<typeof VoiceModeToggle> = {
  title: 'Chat/Input/VoiceModeToggle',
  component: VoiceModeToggle,
  args: { onFinalTranscript: fn() },
  decorators: [
    (Story, context) => {
      const [queryClient] = useState(
        () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
      );
      const [client] = useState(() =>
        trpc.createClient({
          links: [
            () =>
              ({ op }) =>
                observable((observer) => {
                  if (op.path === 'voice.mintGrantToken' && context.parameters.pendingGrant) {
                    return;
                  }
                  if (op.path !== 'voice.getConfig') {
                    observer.error(new TRPCClientError(`No story fixture for ${op.path}`));
                    return;
                  }
                  observer.next({
                    result: {
                      data: {
                        enabled: true,
                        hasApiKey: true,
                        ttsModel: 'aura-2-thalia-en',
                        ttsSpeed: 1,
                        utteranceEndMs: 1000,
                        bargeInSustainedMs: 300,
                      },
                    },
                  });
                  observer.complete();
                }),
          ],
        })
      );
      return (
        <trpc.Provider client={client} queryClient={queryClient}>
          <QueryClientProvider client={queryClient}>
            <Story />
          </QueryClientProvider>
        </trpc.Provider>
      );
    },
  ],
};
export default meta;
type Story = StoryObj<typeof meta>;

export const SessionClosed: Story = {
  args: { sessionId: null },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('button', { name: 'Voice off' })).toBeDisabled();
  },
  parameters: {
    docs: {
      description: {
        story:
          'Closing or switching the selected session stops active or connecting microphone capture. Voice remains off until a session is selected.',
      },
    },
  },
};

export const Connecting: Story = {
  args: { sessionId: 'connecting-story' },
  parameters: { pendingGrant: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Voice off' }));
    await expect(await canvas.findByRole('button', { name: 'Connecting…' })).toBeEnabled();
    // The status badge pulses the shared neutral dot while connecting.
    const dot = canvasElement.querySelector('output [data-status-tone]');
    await expect(dot).toHaveAttribute('data-status-tone', 'neutral');
    await expect(dot).toHaveClass('animate-pulse');
  },
};
export const ConnectingDark: Story = { ...Connecting, globals: { theme: 'dark' } };
