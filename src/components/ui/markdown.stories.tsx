import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { fn } from 'storybook/test';
import { resolveWorkspaceFileLink } from '@/client/lib/workspace-file-links';
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

const STREAMING_REPLY = [
  '## Streaming reply',
  '',
  'Completed blocks stay parsed while the **last** block grows.',
  '',
  '```ts',
  'const first = 1;',
  '',
  'const second = 2;',
  '```',
  '',
  '- tight item',
  '- loose item',
  '',
  '  continued',
  '',
  '| Column | Value |',
  '| ------ | ----: |',
  '| a      |     1 |',
  '',
  'The final paragraph is still arriving',
].join('\n');

function StreamingMarkdownDemo() {
  const [length, setLength] = useState(STREAMING_REPLY.indexOf('| Column'));
  const streaming = length < STREAMING_REPLY.length;
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={() => setLength(0)}>
          Restart
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setLength((current) => Math.min(STREAMING_REPLY.length, current + 40))}
        >
          Stream 40 characters
        </Button>
      </div>
      <MarkdownRenderer content={STREAMING_REPLY.slice(0, length)} streaming={streaming} />
    </div>
  );
}

/** Streaming renders the same output as a finished message, one block at a time. */
export const Streaming: Story = {
  args: { content: STREAMING_REPLY },
  render: () => <StreamingMarkdownDemo />,
};

export const WindowsFileLinks: Story = {
  args: {
    content: [
      'Workspace files on Windows open in the editor:',
      '',
      String.raw`- [foo.ts:12](C:\repo\src\foo.ts:12)`,
      '- [bar.ts](C:/repo/src/bar.ts)',
      '- [Outside the workspace](C:/elsewhere/baz.ts) stays inert',
      '- [Unsafe](javascript:alert(1)) is blanked',
    ].join('\n'),
    resolveWorkspaceFileLink: (href: string) => resolveWorkspaceFileLink(href, String.raw`C:\repo`),
    onWorkspaceFileLink: fn(),
  },
};

export const Mermaid: Story = {
  args: { content: '```mermaid\ngraph LR\n  Workspace --> Session\n  Session --> Result\n```' },
};

export const MermaidClass: Story = {
  args: {
    content: '```mermaid\nclassDiagram\n  Workspace "1" --> "*" Session\n  Session --> Result\n```',
  },
};

export const MermaidState: Story = {
  args: {
    content:
      '```mermaid\nstateDiagram-v2\n  [*] --> Ready\n  Ready --> Running\n  Running --> Complete\n  Complete --> [*]\n```',
  },
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
