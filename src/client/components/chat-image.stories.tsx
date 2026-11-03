import type { Meta, StoryObj } from '@storybook/react';
import { ChatImage } from './chat-image';

const demo = '/social-preview.png';
const meta = {
  title: 'Chat/Inline images',
  component: ChatImage,
  args: { alt: 'Generated mockup', source: '/private/tmp/mockup.png', src: demo },
  decorators: [
    (Story) => (
      <div className="max-w-md p-4">
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
export const Broken: Story = { args: { src: 'data:image/png;base64,AAAA' } };
