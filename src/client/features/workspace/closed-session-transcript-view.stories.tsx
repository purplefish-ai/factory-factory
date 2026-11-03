import type { Meta, StoryObj } from '@storybook/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { observable } from '@trpc/server/observable';
import { useState } from 'react';
import { expect, within } from 'storybook/test';
import { trpc } from '@/client/lib/trpc';
import { ClosedSessionReadTranscriptSchema } from '@/shared/acp-protocol/protocol/closed-session-transcript-schema';
import { ClosedSessionTranscriptView } from './closed-session-transcript-view';

const current = (id: string, content: unknown[]) => ({
  id,
  source: 'agent',
  timestamp: '2026-11-02T12:00:00Z',
  order: 0,
  message: { type: 'assistant', message: { role: 'assistant', content } },
});
const rich = [
  { id: 'human', source: 'user', timestamp: '', order: 0, text: 'Review the archived session.' },
  current('assistant', [
    { type: 'text', text: 'The **archive** preserves rich messages and tool activity.' },
  ]),
  current('call', [
    { type: 'tool_use', id: 'A', name: 'Read', input: { file_path: '/src/example.ts' } },
  ]),
  current('result', [
    { type: 'tool_result', tool_use_id: 'A', content: 'export const archived = true;' },
  ]),
];
const legacy = [
  { role: 'user', content: 'A legacy user message' },
  {
    role: 'assistant',
    content: 'A legacy assistant reply',
    nested: { preserved: [null, true, 42] },
  },
];
const mixed = [
  ...rich.slice(0, 3),
  { type: 'future', nested: { html: '<script>alert("archived text")</script>', preserved: true } },
  current('orphan', [
    {
      type: 'tool_result',
      tool_use_id: 'A',
      content: 'The barrier keeps this entire orphan visible.',
    },
  ]),
  null,
  {
    id: 'last',
    source: 'user',
    timestamp: '',
    order: 0,
    text: 'Rich rendering resumes after raw rows.',
  },
];

function ArchiveFixture({ wire }: { wire: string }) {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
  );
  const [client] = useState(() =>
    trpc.createClient({
      links: [
        () => () =>
          observable((observer) => {
            observer.next({ result: { data: wire } });
            observer.complete();
          }),
      ],
    })
  );
  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <div className="h-[560px] w-[760px] max-w-full rounded border bg-background text-foreground">
          <ClosedSessionTranscriptView sessionId="closed-story" />
        </div>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: 'Workspaces/Closed Session Transcript',
  component: ClosedSessionTranscriptView,
  args: { sessionId: 'closed-story' },
  parameters: { layout: 'padded' },
} satisfies Meta<typeof ClosedSessionTranscriptView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const CurrentRich: Story = {
  render: () => (
    <ArchiveFixture
      wire={JSON.stringify(ClosedSessionReadTranscriptSchema.parse({ messages: rich }))}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Review the archived session.')).toBeVisible();
    await expect(canvas.queryByLabelText('Archived message JSON')).not.toBeInTheDocument();
  },
};
export const LegacyOnly: Story = {
  render: () => (
    <ArchiveFixture
      wire={JSON.stringify(
        ClosedSessionReadTranscriptSchema.parse({
          messages: legacy,
          sessionSummary: 'No version or metadata required',
        })
      )}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findAllByLabelText('Archived message JSON')).toHaveLength(2);
  },
};
export const MixedOrphans: Story = {
  render: () => (
    <ArchiveFixture
      wire={JSON.stringify(
        ClosedSessionReadTranscriptSchema.parse({
          messages: mixed,
          metadata: null,
          version: ['future'],
        })
      )}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findAllByLabelText('Archived message JSON')).toHaveLength(3);
    await expect(canvas.getByText('Rich rendering resumes after raw rows.')).toBeVisible();
    await expect(canvasElement.querySelector('script')).toBeNull();
  },
};

export const CorruptWire: Story = {
  render: () => <ArchiveFixture wire={'{"messages":false}'} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Failed to load transcript')).toBeVisible();
    await expect(canvas.queryByText('Transcript not found')).not.toBeInTheDocument();
  },
};
