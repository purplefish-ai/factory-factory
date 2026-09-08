import type { Meta, StoryObj } from '@storybook/react';
import { MarkdownRenderer } from './markdown';

const meta = {
  title: 'UI/Markdown',
  component: MarkdownRenderer,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof MarkdownRenderer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const PlainMarkdown: Story = {
  args: { content: '# Workspace notes\n\nPlain **Markdown** loads without the diagram engine.' },
};

export const Mermaid: Story = {
  args: { content: '```mermaid\ngraph LR\n  Workspace --> Session\n  Session --> Result\n```' },
};

export const InvalidMermaid: Story = {
  args: { content: '```mermaid\nthis is not a diagram\n```' },
};
