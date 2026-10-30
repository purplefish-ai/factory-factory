import type { Meta, StoryObj } from '@storybook/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { observable } from '@trpc/server/observable';
import { useState } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { z } from 'zod';
import { trpc } from '@/client/lib/trpc';
import { ProviderSubagentsSection } from './provider-subagents-section';
import type { SubagentListItem } from './types';

function storySubagent(index: number, activeCount: number): SubagentListItem {
  const active = index < activeCount;
  return {
    id: `agent-${index}`,
    name: active
      ? (['Bug 12846', 'Audit and scope review'][index] ?? `Active task ${index + 1}`)
      : `Completed task ${index - activeCount + 1}`,
    status: active ? 'running' : 'completed',
    createdAt: '2026-08-08T11:50:00.000Z',
    updatedAt: '2026-08-08T11:59:00.000Z',
    completedAt: active ? null : '2026-08-08T11:59:00.000Z',
    latestActivity: active ? 'Reviewing the implementation' : null,
    resultPreview: active ? null : 'Review complete',
  };
}

function SectionStory({
  activeCount = 2,
  pageSize = 8,
  repeatCursor = false,
}: {
  activeCount?: number;
  pageSize?: number;
  repeatCursor?: boolean;
}) {
  const [queryClient] = useState(() => new QueryClient());
  const [client] = useState(() =>
    trpc.createClient({
      links: [
        () =>
          ({ op }) =>
            observable((observer) => {
              const subagents = Array.from({ length: 8 }, (_, index) =>
                storySubagent(index, activeCount)
              );
              const ordered = [...subagents.slice(activeCount), ...subagents.slice(0, activeCount)];
              const { cursor } = z.object({ cursor: z.string().nullish() }).parse(op.input);
              const offset = Number(cursor ?? 0);
              const end = offset + Math.max(1, pageSize);
              observer.next({
                result: {
                  data: {
                    supported: true,
                    subagents: ordered.slice(offset, end),
                    nextCursor: end < ordered.length ? String(repeatCursor ? pageSize : end) : null,
                  },
                },
              });
              observer.complete();
            }),
      ],
    })
  );
  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <div className="w-[320px] border bg-background">
          <ProviderSubagentsSection
            sessionId="session-1"
            parentSessionName="Chat 1"
            enabled
            onSelect={fn()}
          />
        </div>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: 'Subagents/ProviderSubagentsSection',
  component: SectionStory,
  render: (args) => (
    <SectionStory key={`${args.activeCount}-${args.pageSize}-${args.repeatCursor}`} {...args} />
  ),
} satisfies Meta<typeof SectionStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const TwoActiveOfEight: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByLabelText('Active sub-agents')).toHaveTextContent('2');
    await expect(canvas.getByRole('button', { name: 'Completed · 6' })).toBeVisible();
  },
};

export const CompletedExpanded: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Completed · 6' }));
    await expect(canvas.getByLabelText('Active sub-agents')).toHaveTextContent('2');
    await expect(canvas.getByText('Completed task 1')).toBeVisible();
  },
};

export const AllCompleted: Story = {
  args: { activeCount: 0 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByLabelText('Active sub-agents')).toHaveTextContent('0');
    await expect(canvas.getByRole('button', { name: 'Completed · 8' })).toBeVisible();
  },
};

export const ActiveAgentsOnLaterPages: Story = {
  args: { activeCount: 2, pageSize: 2 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByLabelText('Active sub-agents')).toHaveTextContent('2');
    await expect(canvas.getByText('Bug 12846')).toBeVisible();
    await expect(canvas.getByText('Audit and scope review')).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Completed · 6' })).toBeVisible();
  },
};

export const RepeatedProviderCursor: Story = {
  args: { activeCount: 2, pageSize: 2, repeatCursor: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(
        'The provider repeated a sub-agent page cursor. Retry to reload the list.'
      )
    ).toBeVisible();
    await expect(canvas.queryByLabelText('Active sub-agents')).not.toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: 'Retry' })).toBeVisible();
  },
};
