import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { TerminalInstance } from './terminal-instance';

const meta = {
  title: 'Workspace/Terminal Output',
  component: TerminalInstance,
  parameters: { layout: 'centered' },
  args: { onData: () => undefined, onResize: () => undefined },
} satisfies Meta<typeof TerminalInstance>;

export default meta;
type Story = StoryObj<typeof meta>;

function ReplayPreview({ truncated = false }: { truncated?: boolean }) {
  const [replayed, setReplayed] = useState(false);
  const before = '$ pnpm test\r\nRunning 12 tests...\r\n';
  const after = truncated
    ? 'Older output has rolled out of the buffer.\r\n12 passed (12)\r\n$ '
    : `${before}12 passed (12)\r\n$ `;
  return (
    <div className="w-[700px] space-y-3">
      <p className="text-sm text-muted-foreground">
        {replayed ? 'Reconnected: server output restored.' : 'Disconnected while tests finish.'}
      </p>
      <Button onClick={() => setReplayed(!replayed)}>
        {replayed ? 'Reset preview' : 'Replay reconnect buffer'}
      </Button>
      <div className="h-[280px] overflow-hidden rounded border bg-background">
        <TerminalInstance
          output={replayed ? after : before}
          onData={() => undefined}
          onResize={() => undefined}
          className="h-full"
        />
      </div>
    </div>
  );
}

export const ReconnectReplay: Story = {
  args: { output: '' },
  render: () => <ReplayPreview />,
};

export const RollingWindowReplay: Story = {
  args: { output: '' },
  render: () => <ReplayPreview truncated />,
};
