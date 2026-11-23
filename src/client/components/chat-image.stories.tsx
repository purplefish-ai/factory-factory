import type { Meta, StoryObj } from '@storybook/react';
import { expect, within } from 'storybook/test';
import { ChatImage } from './chat-image';

const demo = '/social-preview.png';
const meta = {
  title: 'Chat/Transcript/ChatImage',
  component: ChatImage,
  args: { alt: 'Generated mockup', source: '/private/tmp/mockup.png', src: demo },
  decorators: [
    (Story) => (
      <div className="w-[calc(100vw-2rem)] max-w-md p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ChatImage>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Available: Story = {};
export const Linked: Story = {
  args: { interactive: false, title: 'Design preview' },
  render: (args) => (
    <a href="https://example.com/design">
      <ChatImage {...args} />
    </a>
  ),
};
export const Loading: Story = { args: { src: undefined, loading: true } };
export const Missing: Story = { args: { src: undefined } };
export const Unsupported: Story = { args: { src: undefined, source: '/private/tmp/mockup.svg' } };
export const EmbeddedFallback: Story = {
  args: { src: undefined, source: 'data:image/svg+xml;base64,PHN2Zy8+' },
};
export const Broken: Story = { args: { src: 'data:image/png;base64,AAAA' } };
/** A referenced image reserves its space from the dimensions sent with it. */
export const ReservedSpace: Story = { args: { width: 1200, height: 630 } };
/** A referenced image the server no longer holds offers to load again. */
export const RetryableFailure: Story = {
  args: { src: 'data:image/png;base64,AAAA', retryable: true, source: undefined },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('button', { name: 'Retry' })).toBeVisible();
  },
};
