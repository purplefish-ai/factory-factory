import type { Meta, StoryObj } from '@storybook/react';
import { useEffect } from 'react';
import { fn } from 'storybook/test';
import { trpc } from '@/client/lib/trpc';
import { VoiceModeToggle } from './voice-mode-toggle';

const meta: Meta<typeof VoiceModeToggle> = {
  title: 'Voice/VoiceModeToggle',
  component: VoiceModeToggle,
  args: { onFinalTranscript: fn() },
  decorators: [
    (Story) => {
      const utils = trpc.useUtils();
      useEffect(() => {
        utils.voice.getConfig.setData(undefined, {
          enabled: true,
          hasApiKey: true,
          ttsModel: 'aura-2-thalia-en',
          ttsSpeed: 1,
          utteranceEndMs: 1000,
          bargeInSustainedMs: 300,
        });
      }, [utils]);
      return <Story />;
    },
  ],
};
export default meta;
type Story = StoryObj<typeof meta>;

export const SessionClosed: Story = {
  args: { sessionId: null },
  parameters: {
    docs: {
      description: {
        story:
          'Closing the selected session stops active or connecting microphone capture. Voice remains off until a session is selected.',
      },
    },
  },
};
