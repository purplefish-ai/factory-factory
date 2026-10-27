import type { Meta, StoryObj } from '@storybook/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { observable } from '@trpc/server/observable';
import { useState } from 'react';
import { fn, userEvent, within } from 'storybook/test';
import { ChatInput } from '@/client/features/chat/chat-input/chat-input';
import { trpc } from '@/client/lib/trpc';
import { createEmptyTokenStats } from '@/lib/chat-protocol';
import { EMPTY_CHAT_BAR_CAPABILITIES } from '@/shared/chat-capabilities';
import type { ProviderPlanUsage } from '@/shared/provider-usage';
import { UsageControl } from './provider-usage-control';

const plan: ProviderPlanUsage = {
  provider: 'CLAUDE',
  status: 'available',
  updatedAt: '2026-10-27T15:30:00Z',
  windows: [
    { id: 'five-hour', label: '5-hour limit', usedPercent: 28, resetsAt: 1_793_124_000 },
    { id: 'weekly', label: 'Weekly limit', usedPercent: 64, resetsAt: 1_793_390_400 },
  ],
};
const meta: Meta<typeof UsageControl> = {
  title: 'Chat/UsageStats/Combined',
  component: UsageControl,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  args: {
    tokenStats: { ...createEmptyTokenStats(), contextUsedTokens: 76_000, contextWindow: 200_000 },
    planUsage: plan,
    onCompact: fn(),
    onRefresh: fn(),
  },
};
export default meta;
type Story = StoryObj<typeof meta>;
export const Quiet: Story = {};
export const Details: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: /Usage/ }));
  },
};
export const PlanWarning: Story = {
  args: {
    planUsage: {
      ...plan,
      provider: 'CODEX',
      windows: [
        { id: 'session', label: '5-hour limit', usedPercent: 94, resetsAt: 1_793_124_000 },
        { id: 'weekly', label: 'Weekly limit', usedPercent: 72, resetsAt: 1_793_390_400 },
      ],
    },
  },
  play: Details.play,
};
export const ContextWarning: Story = {
  args: {
    tokenStats: { ...createEmptyTokenStats(), contextUsedTokens: 192_000, contextWindow: 200_000 },
  },
  play: Details.play,
};
export const Compacting: Story = { args: { compacting: true }, play: Details.play };
export const ContextUnknown: Story = {
  args: { tokenStats: createEmptyTokenStats() },
  play: Details.play,
};
export const Unavailable: Story = {
  args: {
    planUsage: {
      ...plan,
      status: 'unavailable',
      windows: [],
      message: 'Sign in to read plan limits.',
    },
  },
  play: Details.play,
};
export const RefreshFailed: Story = { args: { error: true }, play: Details.play };
export const NarrowComposer: Story = {
  render: (args) => (
    <div className="w-[296px] rounded-md border bg-background">
      <div className="p-3 text-xs text-muted-foreground">Ask a follow-up…</div>
      <div className="flex items-center justify-between gap-1 border-t px-2 py-1">
        <span className="text-xs text-muted-foreground">Codex · Options</span>
        <div className="flex items-center gap-1">
          <UsageControl {...args} />
          <button
            type="button"
            className="h-7 rounded bg-primary px-2 text-xs text-primary-foreground"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  ),
  play: Details.play,
};

function ConnectedComposerPreview() {
  const [queryClient] = useState(() => new QueryClient());
  const [client] = useState(() =>
    trpc.createClient({
      links: [
        () => () =>
          observable((observer) => {
            observer.next({ result: { data: plan } });
            observer.complete();
          }),
      ],
    })
  );
  const [draft, setDraft] = useState('Keep this draft while compacting');
  const [compacting, setCompacting] = useState(false);
  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <div className="w-[min(620px,calc(100vw-32px))]">
          <ChatInput
            onSend={fn()}
            onCompact={() => setCompacting(true)}
            isCompacting={compacting}
            value={draft}
            onChange={setDraft}
            capabilities={{
              ...EMPTY_CHAT_BAR_CAPABILITIES,
              usageStats: { enabled: true, contextWindow: true },
              model: {
                enabled: true,
                selected: 'opus',
                options: [{ value: 'opus', label: 'Opus' }],
              },
            }}
            tokenStats={{
              ...createEmptyTokenStats(),
              contextUsedTokens: 76_000,
              contextWindow: 200_000,
            }}
          />
        </div>
      </QueryClientProvider>
    </trpc.Provider>
  );
}
export const ConnectedComposer: Story = {
  render: () => <ConnectedComposerPreview />,
  play: Details.play,
};
