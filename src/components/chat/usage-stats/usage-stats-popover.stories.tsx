import type { Meta, StoryObj } from '@storybook/react';

import { createTokenStats } from '@/lib/claude-fixtures';
import { UsageStatsPopover } from './usage-stats-popover';

const meta: Meta<typeof UsageStatsPopover> = {
  title: 'Chat/UsageStats/UsageStatsPopover',
  component: UsageStatsPopover,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="w-64 border rounded-md shadow-lg bg-popover">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof meta>;

export const MinimalStats: Story = {
  name: 'New Session (Minimal)',
  args: {
    tokenStats: createTokenStats({
      inputTokens: 500,
      outputTokens: 200,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalCostUsd: 0.001,
      totalDurationMs: 1500,
      totalDurationApiMs: 1200,
      turnCount: 1,
      webSearchRequests: 0,
      contextWindow: 200_000,
    }),
  },
};

export const ActiveSession: Story = {
  name: 'Active Session (Full Stats)',
  args: {
    tokenStats: createTokenStats({
      inputTokens: 45_000,
      outputTokens: 12_000,
      cacheReadInputTokens: 35_000,
      cacheCreationInputTokens: 5000,
      totalCostUsd: 0.0847,
      totalDurationMs: 45_000,
      totalDurationApiMs: 38_000,
      turnCount: 8,
      webSearchRequests: 0,
      contextWindow: 200_000,
    }),
  },
};

export const WithWebSearches: Story = {
  name: 'With Web Searches',
  args: {
    tokenStats: createTokenStats({
      inputTokens: 30_000,
      outputTokens: 8000,
      cacheReadInputTokens: 20_000,
      cacheCreationInputTokens: 3000,
      totalCostUsd: 0.125,
      totalDurationMs: 60_000,
      totalDurationApiMs: 50_000,
      turnCount: 5,
      webSearchRequests: 3,
      contextWindow: 200_000,
    }),
  },
};

export const HighCacheHitRate: Story = {
  name: 'High Cache Hit Rate',
  args: {
    tokenStats: createTokenStats({
      inputTokens: 25_000,
      outputTokens: 5000,
      cacheReadInputTokens: 50_000,
      cacheCreationInputTokens: 2000,
      totalCostUsd: 0.042,
      totalDurationMs: 30_000,
      totalDurationApiMs: 25_000,
      turnCount: 10,
      webSearchRequests: 0,
      contextWindow: 200_000,
    }),
  },
};

export const WarningUsage: Story = {
  name: 'Warning Level (85%)',
  args: {
    tokenStats: createTokenStats({
      inputTokens: 120_000,
      outputTokens: 50_000,
      cacheReadInputTokens: 80_000,
      cacheCreationInputTokens: 10_000,
      totalCostUsd: 0.95,
      totalDurationMs: 180_000,
      totalDurationApiMs: 150_000,
      turnCount: 25,
      webSearchRequests: 2,
      contextWindow: 200_000,
    }),
  },
};

export const CriticalUsage: Story = {
  name: 'Critical Level (97%)',
  args: {
    tokenStats: createTokenStats({
      inputTokens: 140_000,
      outputTokens: 54_000,
      cacheReadInputTokens: 90_000,
      cacheCreationInputTokens: 15_000,
      totalCostUsd: 1.23,
      totalDurationMs: 240_000,
      totalDurationApiMs: 200_000,
      turnCount: 35,
      webSearchRequests: 5,
      contextWindow: 200_000,
    }),
  },
};

export const WithServiceTier: Story = {
  name: 'With Service Tier',
  args: {
    tokenStats: createTokenStats({
      inputTokens: 20_000,
      outputTokens: 5000,
      totalCostUsd: 0.05,
      totalDurationMs: 20_000,
      totalDurationApiMs: 15_000,
      turnCount: 4,
      contextWindow: 200_000,
      serviceTier: 'scale',
    }),
  },
};

export const NoContextWindow: Story = {
  name: 'No Context Window',
  args: {
    tokenStats: createTokenStats({
      inputTokens: 10_000,
      outputTokens: 3000,
      totalCostUsd: 0.02,
      totalDurationMs: 10_000,
      totalDurationApiMs: 8000,
      turnCount: 2,
      contextWindow: null,
    }),
  },
};
