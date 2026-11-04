import type { Meta, StoryObj } from '@storybook/react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { MarkdownRenderer } from './markdown';
import { renderStreamdownContent } from './streamdown-markdown';
import {
  STREAMING_CODE,
  STREAMING_LINKS,
  STREAMING_PROSE,
  STREAMING_STRUCTURES,
} from './streamdown-markdown.fixtures';

const STEADY_CHUNKS = [12];
const BURSTY_CHUNKS = [0, 0, 0, 8, 0, 0, 160, 0, 0, 0, 48];
const CODE_CHUNKS = [80];

function resolveFile(href: string) {
  return href.startsWith('/demo/repo/') || href.startsWith('C:/repo/') ? 'src/file.ts:12' : null;
}

interface ComparisonProps {
  content: string;
  chunks: number[];
  snapshotMs: number;
}

function Comparison({ content, chunks, snapshotMs }: ComparisonProps) {
  const cursor = useRef(0);
  const tick = useRef(0);
  const [received, setReceived] = useState(0);
  const [visible, setVisible] = useState(0);
  // Replacing playback also restarts the clock when already playing.
  const [playback, setPlayback] = useState({ playing: true, revision: 0 });
  const playing = playback.playing;
  const [opened, setOpened] = useState<string | null>(null);

  useEffect(() => {
    if (!playback.playing) {
      return;
    }
    let lastSnapshot = performance.now();
    const timer = setInterval(() => {
      cursor.current = Math.min(
        content.length,
        cursor.current + (chunks[tick.current % chunks.length] ?? 0)
      );
      tick.current++;
      setReceived(cursor.current);
      const complete = cursor.current === content.length;
      const now = performance.now();
      if (complete || now - lastSnapshot >= snapshotMs) {
        setVisible(cursor.current);
        lastSnapshot = now;
      }
      if (complete) {
        setPlayback((value) => ({ ...value, playing: false }));
      }
    }, 25);
    return () => clearInterval(timer);
  }, [content, chunks, playback, snapshotMs]);

  const restart = () => {
    cursor.current = 0;
    tick.current = 0;
    setReceived(0);
    setVisible(0);
    setPlayback((value) => ({ playing: true, revision: value.revision + 1 }));
  };
  const finish = () => {
    cursor.current = content.length;
    setReceived(content.length);
    setVisible(content.length);
    setPlayback((value) => ({ ...value, playing: false }));
  };
  const streaming = received < content.length;
  const text = content.slice(0, visible);
  return (
    <div className="w-full space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={restart}>
          Restart
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!streaming}
          onClick={() => setPlayback((value) => ({ ...value, playing: !value.playing }))}
        >
          {playing ? 'Pause' : 'Resume'}
        </Button>
        <Button size="sm" variant="outline" onClick={finish}>
          Finish now
        </Button>
        <span className="text-xs text-muted-foreground" aria-live="off">
          {received} received · {visible} rendered ·{' '}
          {streaming ? (playing ? 'Streaming' : 'Paused') : 'Complete'}
        </span>
      </div>
      <p className="text-sm text-muted-foreground">
        Identical snapshots every {snapshotMs} ms. Streamdown uses 120 ms word fades with no
        stagger. This compares text rendering; transcript scroll behavior is unchanged.
      </p>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {['React Markdown baseline', 'Streamdown'].map((label, index) => (
          <section key={`${label}:${playback.revision}`} className="min-w-0 rounded-md border p-4">
            <h2 className="mb-4 border-b pb-2 text-sm font-medium">{label}</h2>
            <div className="max-h-[32rem] overflow-auto">
              <MarkdownRenderer
                content={text}
                streaming={streaming}
                resolveWorkspaceFileLink={resolveFile}
                onWorkspaceFileLink={setOpened}
                renderContent={index === 1 ? renderStreamdownContent : undefined}
              />
            </div>
          </section>
        ))}
      </div>
      {opened && (
        <p className="text-sm" role="status">
          Opened workspace file: {opened}
        </p>
      )}
    </div>
  );
}

const meta = {
  title: 'Chat/Transcript/StreamdownMarkdown',
  component: Comparison,
  parameters: { layout: 'padded' },
  args: { content: STREAMING_PROSE, chunks: STEADY_CHUNKS, snapshotMs: 100 },
  argTypes: {
    snapshotMs: { control: { type: 'select' }, options: [25, 50, 100] },
    content: { table: { disable: true } },
    chunks: { table: { disable: true } },
  },
  render: (args) => <Comparison key={`${args.content}:${args.snapshotMs}`} {...args} />,
} satisfies Meta<typeof Comparison>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Prose: Story = {};
export const BurstyDelivery: Story = { args: { chunks: BURSTY_CHUNKS } };
export const LongCode: Story = { args: { content: STREAMING_CODE, chunks: CODE_CHUNKS } };
export const TablesAndDiagrams: Story = { args: { content: STREAMING_STRUCTURES } };
export const ApplicationLinksAndImages: Story = {
  args: { content: STREAMING_LINKS, chunks: [200] },
};
