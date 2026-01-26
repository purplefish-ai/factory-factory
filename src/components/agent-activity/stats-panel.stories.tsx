import type { Meta, StoryObj } from '@storybook/react';
import { createTokenStats } from '@/lib/claude-fixtures';
import { StatsPanel } from './stats-panel';

const meta = {
  title: 'AgentActivity/StatsPanel',
  component: StatsPanel,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    variant: {
      control: 'select',
      options: ['card', 'inline', 'compact'],
      description: 'Visual variant of the stats panel',
    },
  },
} satisfies Meta<typeof StatsPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

// =============================================================================
// Variant Stories
// =============================================================================

export const CardVariant: Story = {
  args: {
    variant: 'card',
    stats: createTokenStats({
      inputTokens: 2500,
      outputTokens: 1200,
      totalCostUsd: 0.0185,
      totalDurationMs: 8500,
      turnCount: 4,
    }),
  },
};

export const InlineVariant: Story = {
  args: {
    variant: 'inline',
    stats: createTokenStats({
      inputTokens: 1500,
      outputTokens: 850,
      totalCostUsd: 0.0125,
      totalDurationMs: 3500,
      turnCount: 3,
    }),
  },
};

export const CompactVariant: Story = {
  args: {
    variant: 'compact',
    stats: createTokenStats({
      inputTokens: 1500,
      outputTokens: 850,
      totalCostUsd: 0.0125,
      totalDurationMs: 3500,
      turnCount: 3,
    }),
  },
};

// =============================================================================
// Edge Case Stories
// =============================================================================

export const ZeroStats: Story = {
  args: {
    variant: 'card',
    stats: createTokenStats({
      inputTokens: 0,
      outputTokens: 0,
      totalCostUsd: 0,
      totalDurationMs: 0,
      turnCount: 0,
    }),
  },
};

export const HighUsage: Story = {
  args: {
    variant: 'card',
    stats: createTokenStats({
      inputTokens: 150_000,
      outputTokens: 85_000,
      totalCostUsd: 2.85,
      totalDurationMs: 125_000,
      turnCount: 45,
    }),
  },
};

export const VeryHighUsage: Story = {
  args: {
    variant: 'card',
    stats: createTokenStats({
      inputTokens: 1_500_000,
      outputTokens: 850_000,
      totalCostUsd: 28.5,
      totalDurationMs: 3_600_000, // 1 hour
      turnCount: 150,
    }),
  },
};

export const LongDuration: Story = {
  args: {
    variant: 'card',
    stats: createTokenStats({
      inputTokens: 5000,
      outputTokens: 2500,
      totalCostUsd: 0.05,
      totalDurationMs: 7_200_000, // 2 hours
      turnCount: 20,
    }),
  },
};

export const ExpensiveRun: Story = {
  args: {
    variant: 'card',
    stats: createTokenStats({
      inputTokens: 500_000,
      outputTokens: 250_000,
      totalCostUsd: 15.75,
      totalDurationMs: 45_000,
      turnCount: 25,
    }),
  },
};

export const SmallCost: Story = {
  args: {
    variant: 'card',
    stats: createTokenStats({
      inputTokens: 100,
      outputTokens: 50,
      totalCostUsd: 0.0001,
      totalDurationMs: 500,
      turnCount: 1,
    }),
  },
};

export const MediumCost: Story = {
  args: {
    variant: 'card',
    stats: createTokenStats({
      inputTokens: 5000,
      outputTokens: 2500,
      totalCostUsd: 0.045,
      totalDurationMs: 12_000,
      turnCount: 8,
    }),
  },
};

// =============================================================================
// Composite Stories
// =============================================================================

const defaultStats = createTokenStats({
  inputTokens: 2500,
  outputTokens: 1200,
  totalCostUsd: 0.0185,
  totalDurationMs: 8500,
  turnCount: 4,
});

export const AllVariants: Story = {
  args: {
    variant: 'card',
    stats: defaultStats,
  },
  render: () => (
    <div className="space-y-8">
      <div>
        <h3 className="text-sm font-medium mb-2">Card Variant</h3>
        <div className="w-64">
          <StatsPanel
            variant="card"
            stats={createTokenStats({
              inputTokens: 2500,
              outputTokens: 1200,
              totalCostUsd: 0.0185,
              totalDurationMs: 8500,
              turnCount: 4,
            })}
          />
        </div>
      </div>
      <div>
        <h3 className="text-sm font-medium mb-2">Inline Variant</h3>
        <StatsPanel
          variant="inline"
          stats={createTokenStats({
            inputTokens: 2500,
            outputTokens: 1200,
            totalCostUsd: 0.0185,
            totalDurationMs: 8500,
            turnCount: 4,
          })}
        />
      </div>
      <div>
        <h3 className="text-sm font-medium mb-2">Compact Variant</h3>
        <StatsPanel
          variant="compact"
          stats={createTokenStats({
            inputTokens: 2500,
            outputTokens: 1200,
            totalCostUsd: 0.0185,
            totalDurationMs: 8500,
            turnCount: 4,
          })}
        />
      </div>
    </div>
  ),
};

export const ProgressionExample: Story = {
  args: {
    variant: 'card',
    stats: defaultStats,
  },
  render: () => (
    <div className="space-y-4">
      <h3 className="text-sm font-medium">Session Progression</h3>
      <div className="flex flex-wrap gap-4">
        <div className="w-64">
          <p className="text-xs text-muted-foreground mb-1">Turn 1</p>
          <StatsPanel
            variant="card"
            stats={createTokenStats({
              inputTokens: 500,
              outputTokens: 200,
              totalCostUsd: 0.003,
              totalDurationMs: 1500,
              turnCount: 1,
            })}
          />
        </div>
        <div className="w-64">
          <p className="text-xs text-muted-foreground mb-1">Turn 5</p>
          <StatsPanel
            variant="card"
            stats={createTokenStats({
              inputTokens: 3500,
              outputTokens: 1800,
              totalCostUsd: 0.025,
              totalDurationMs: 12_000,
              turnCount: 5,
            })}
          />
        </div>
        <div className="w-64">
          <p className="text-xs text-muted-foreground mb-1">Turn 15</p>
          <StatsPanel
            variant="card"
            stats={createTokenStats({
              inputTokens: 15_000,
              outputTokens: 8500,
              totalCostUsd: 0.12,
              totalDurationMs: 45_000,
              turnCount: 15,
            })}
          />
        </div>
      </div>
    </div>
  ),
};

export const CompactInContext: Story = {
  args: {
    variant: 'compact',
    stats: defaultStats,
  },
  render: () => (
    <div className="flex items-center gap-4 rounded-md border px-3 py-2 bg-muted/30">
      <span className="text-sm font-medium">Agent Activity</span>
      <div className="flex-1" />
      <StatsPanel
        variant="compact"
        stats={createTokenStats({
          inputTokens: 2500,
          outputTokens: 1200,
          totalCostUsd: 0.0185,
          totalDurationMs: 8500,
          turnCount: 4,
        })}
      />
    </div>
  ),
};

export const InlineInContext: Story = {
  args: {
    variant: 'inline',
    stats: defaultStats,
  },
  render: () => (
    <div className="space-y-2 rounded-md border p-4">
      <div className="text-sm font-medium">Session Complete</div>
      <StatsPanel
        variant="inline"
        stats={createTokenStats({
          inputTokens: 5000,
          outputTokens: 2500,
          totalCostUsd: 0.045,
          totalDurationMs: 25_000,
          turnCount: 8,
        })}
      />
    </div>
  ),
};
