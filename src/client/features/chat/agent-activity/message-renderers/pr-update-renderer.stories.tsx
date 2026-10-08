import type { Meta, StoryObj } from '@storybook/react';
import { PRUpdateRenderer } from './pr-update-renderer';

const meta = { title: 'Chat/PR update', component: PRUpdateRenderer } satisfies Meta<
  typeof PRUpdateRenderer
>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Delivered: Story = {
  args: {
    text: '<!-- factory-factory-pr-event:example -->\nPR #12 · CI failed\nhttps://github.com/org/repo/pull/12\nCheck: unit tests',
  },
};
export const Queued: Story = { args: { ...Delivered.args, queued: true } };
