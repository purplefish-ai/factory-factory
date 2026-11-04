import type { Meta, StoryObj } from '@storybook/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { observable } from '@trpc/server/observable';
import { useRef, useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import { VoiceModeSection } from './VoiceModeSection';

function StaleVoiceSettings() {
  const config = useRef({
    enabled: true,
    hasApiKey: true,
    ttsSpeed: 1,
    ttsModel: 'flux-haley-en',
    utteranceEndMs: 1000,
    bargeInSustainedMs: 16,
  });
  const [queryClient] = useState(() => new QueryClient());
  const [client] = useState(() =>
    trpc.createClient({
      links: [
        () =>
          ({ op }) =>
            observable((observer) => {
              if (op.path === 'voice.updateConfig') {
                config.current = {
                  ...config.current,
                  ...(op.input as Partial<typeof config.current>),
                };
              }
              observer.next({ result: { data: { ...config.current } } });
              observer.complete();
            }),
      ],
    })
  );
  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <div className="max-w-3xl space-y-4">
          <Button
            onClick={() => {
              config.current.enabled = false;
            }}
          >
            Disable voice mode in another tab
          </Button>
          <VoiceModeSection />
        </div>
      </QueryClientProvider>
    </trpc.Provider>
  );
}
const meta = {
  title: 'Settings/VoiceModeSection',
  component: StaleVoiceSettings,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof StaleVoiceSettings>;
export default meta;
type Story = StoryObj<typeof meta>;
export const StaleTabIndependentSave: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const enabled = await canvas.findByRole('switch', { name: 'Enable voice mode' });
    await expect(enabled).toBeChecked();
    await userEvent.click(
      canvas.getByRole('button', { name: 'Disable voice mode in another tab' })
    );
    await userEvent.click(canvas.getByLabelText('Voice', { exact: true }));
    await userEvent.click(await within(document.body).findByRole('option', { name: /Jack/ }));
    await waitFor(() => expect(enabled).not.toBeChecked());
  },
};

export const NarrowPhone: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  render: () => (
    <div className="w-[320px] max-w-full p-3">
      <VoiceModeSection />
    </div>
  ),
  parameters: {
    layout: 'fullscreen',
    trpc: {
      handlers: {
        'voice.getConfig': () => ({
          enabled: true,
          hasApiKey: true,
          ttsSpeed: 1,
          ttsModel: 'flux-haley-en',
          utteranceEndMs: 1000,
          bargeInSustainedMs: 16,
        }),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByLabelText('Deepgram API Key');
    const content = canvasElement.querySelector('[data-slot="card-content"]');
    if (!content) {
      throw new Error('Voice settings content is missing');
    }
    const right = content.getBoundingClientRect().right - 12;
    for (const control of canvas
      .getAllByRole('slider')
      .concat(canvas.getAllByRole('combobox'), [canvas.getByLabelText('Deepgram API Key')])) {
      await expect(control.getBoundingClientRect().right).toBeLessThanOrEqual(right + 1);
    }
  },
};
