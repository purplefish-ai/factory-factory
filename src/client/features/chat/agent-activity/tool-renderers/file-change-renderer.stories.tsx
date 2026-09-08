import type { Meta, StoryObj } from '@storybook/react';
import { CodexFileChangeRenderer } from './file-change-renderer';

const meta = {
  title: 'Chat/Tools/File Changes',
  component: CodexFileChangeRenderer,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof CodexFileChangeRenderer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const RepeatedPaths: Story = {
  args: {
    payload: {
      changes: [
        { path: 'src/example.ts', kind: 'update', diff: '-first\n+second' },
        { path: 'src/example.ts', kind: 'update', diff: '-second\n+third' },
        { path: 'src/added.ts', kind: 'create', diff: '+export const added = true;' },
      ],
    },
  },
};
