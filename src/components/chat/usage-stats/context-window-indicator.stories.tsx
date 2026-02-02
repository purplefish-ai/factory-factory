import type { Meta, StoryObj } from '@storybook/react';
import { createTokenStats } from '@/lib/claude-fixtures';
import type { TokenStats } from '@/lib/claude-types';
import { ContextWindowIndicator } from './context-window-indicator';

const meta: Meta<typeof ContextWindowIndicator> = {
  title: 'Chat/UsageStats/ContextWindowIndicator',
  component: ContextWindowIndicator,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof meta>;

// Helper to create token stats with specific usage percentage
function createStatsWithUsage(usagePercent: number, contextWindow = 200_000): TokenStats {
  const usedTokens = Math.round(contextWindow * (usagePercent / 100));
  const inputTokens = Math.round(usedTokens * 0.7);
  const outputTokens = usedTokens - inputTokens;

  return createTokenStats({
    inputTokens,
    outputTokens,
    contextWindow,
    totalCostUsd: usedTokens * 0.000_01,
    turnCount: Math.ceil(usagePercent / 10),
  });
}

export const LowUsage: Story = {
  args: {
    tokenStats: createStatsWithUsage(30),
  },
};

export const MediumUsage: Story = {
  args: {
    tokenStats: createStatsWithUsage(60),
  },
};

export const WarningLevel: Story = {
  args: {
    tokenStats: createStatsWithUsage(85),
  },
};

export const CriticalLevel: Story = {
  args: {
    tokenStats: createStatsWithUsage(97),
  },
};

export const NoContextWindow: Story = {
  name: 'No Context Window Info',
  args: {
    tokenStats: createTokenStats({
      inputTokens: 5000,
      outputTokens: 2000,
      contextWindow: null,
    }),
  },
};

export const Empty: Story = {
  name: 'Empty (No Data)',
  args: {
    tokenStats: createTokenStats({
      inputTokens: 0,
      outputTokens: 0,
    }),
  },
};

export const AllStates: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-4">
        <span className="text-sm text-muted-foreground w-24">Low (30%)</span>
        <ContextWindowIndicator tokenStats={createStatsWithUsage(30)} />
      </div>
      <div className="flex items-center gap-4">
        <span className="text-sm text-muted-foreground w-24">Medium (60%)</span>
        <ContextWindowIndicator tokenStats={createStatsWithUsage(60)} />
      </div>
      <div className="flex items-center gap-4">
        <span className="text-sm text-muted-foreground w-24">Warning (85%)</span>
        <ContextWindowIndicator tokenStats={createStatsWithUsage(85)} />
      </div>
      <div className="flex items-center gap-4">
        <span className="text-sm text-muted-foreground w-24">Critical (97%)</span>
        <ContextWindowIndicator tokenStats={createStatsWithUsage(97)} />
      </div>
    </div>
  ),
};
