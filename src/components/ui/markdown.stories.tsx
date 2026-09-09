import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { Button } from './button';
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

export const MermaidRecovery: Story = {
  args: { content: '' },
  render: function Recovery() {
    const [complete, setComplete] = useState(false);
    return (
      <>
        <Button onClick={() => setComplete((value) => !value)}>
          {complete ? 'Show incomplete diagram' : 'Complete diagram'}
        </Button>
        <MarkdownRenderer
          content={
            complete
              ? '```mermaid\ngraph LR\n  Workspace --> Session\n```'
              : '```mermaid\ngraph LR\n  Workspace -->\n```'
          }
        />
      </>
    );
  },
};
