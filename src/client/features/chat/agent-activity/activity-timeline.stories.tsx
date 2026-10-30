import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import type { ChatMessage, GroupedMessageItem, PairedToolCall } from '@/lib/chat-protocol';
import { GroupedMessageItemRenderer } from './agent-activity';

const meta = {
  title: 'AgentActivity/ActivityTimeline',
  component: GroupedMessageItemRenderer,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof GroupedMessageItemRenderer>;
export default meta;
type Story = StoryObj<typeof meta>;

function prose(id: string, text: string): ChatMessage {
  return {
    id,
    source: 'agent',
    order: 0,
    timestamp: '2026-10-30T12:00:00Z',
    message: { type: 'assistant', message: { role: 'assistant', content: text } },
  };
}
function agent(phase: 'started' | 'finished', status = 'completed'): ChatMessage {
  return {
    id: `subagent-audit-${phase}`,
    source: 'agent',
    order: 0,
    timestamp: '2026-10-30T12:00:00Z',
    message: {
      type: 'system',
      subtype: `subagent_${phase}`,
      status,
      text: `Audit capture fix ${phase === 'started' ? 'started working' : status === 'completed' ? 'finished' : status}`,
    },
  };
}
const calls: PairedToolCall[] = [
  {
    id: 'edit',
    name: 'Edit',
    input: { file_path: 'src/capture.ts', old_string: 'retry: false', new_string: 'retry: true' },
    status: 'success',
    result: { content: 'File edited successfully', isError: false },
  },
  {
    id: 'test',
    name: 'Run',
    input: { command: ['zsh', '-lc', 'pnpm test && git diff --check'] },
    status: 'success',
    result: { content: 'All 62 tests passed', isError: false },
  },
  {
    id: 'diff',
    name: 'Bash',
    input: { command: 'git diff --stat' },
    status: 'success',
    result: { content: 'src/capture.ts | 2 +-', isError: false },
  },
];
const items: GroupedMessageItem[] = [
  prose(
    'intro',
    'I’ll continue with local evidence. The recovery fix passed its simplification review; I’m finishing the checks.'
  ),
  { type: 'tool_sequence', id: 'tools', pairedCalls: calls },
  agent('started', 'running'),
  prose(
    'progress',
    'All 62 tests passed, along with lint and type checks. I’m preparing the change for review.'
  ),
  agent('finished'),
];

export const Conversation: Story = {
  args: { item: items[0]!, onOpenAgents: fn() },
  render: (args) => (
    <div className="mx-auto max-w-3xl space-y-2">
      {items.map((item) => (
        <GroupedMessageItemRenderer key={item.id} {...args} item={item} />
      ))}
    </div>
  ),
};
export const RunningAndFailed: Story = {
  args: { item: items[0]!, onOpenAgents: fn() },
  render: (args) => (
    <div className="mx-auto max-w-3xl space-y-2">
      <GroupedMessageItemRenderer {...args} item={agent('started', 'running')} />
      <GroupedMessageItemRenderer
        {...args}
        item={{
          type: 'tool_sequence',
          id: 'running',
          pairedCalls: [{ ...calls[1]!, status: 'pending', result: undefined }],
        }}
      />
      <GroupedMessageItemRenderer
        {...args}
        item={{
          type: 'tool_sequence',
          id: 'failed',
          pairedCalls: [
            calls[0]!,
            {
              ...calls[1]!,
              status: 'error',
              result: { content: 'Test failed: expected retry to recover', isError: true },
            },
          ],
        }}
      />
      <GroupedMessageItemRenderer {...args} item={agent('finished', 'failed')} />
    </div>
  ),
};
export const LongCommand: Story = {
  args: {
    item: {
      type: 'tool_sequence',
      id: 'long',
      pairedCalls: [
        {
          ...calls[1]!,
          input: {
            command:
              'tail -35 /tmp/capture-green.log; ps -Ao pid,ppid,etime,command | rg test; pnpm typecheck; git diff --check; git diff --stat',
          },
        },
      ],
    },
  },
};
