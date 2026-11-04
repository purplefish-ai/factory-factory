import type { Meta, StoryObj } from '@storybook/react';
import type { PairedToolCall } from '@/lib/chat-protocol';
import { ToolSequenceGroup } from './tool-renderers';

const calls: PairedToolCall[] = [
  {
    id: 'shell',
    name: 'Bash',
    input: { command: 'git status --short --branch' },
    status: 'success',
  },
  {
    id: 'list',
    name: 'List files in /project/tasks',
    input: { path: '/project/tasks' },
    status: 'success',
  },
  {
    id: 'codex',
    name: 'mcp.codex_apps.github.fetch_pr_comments',
    input: { pr: 123 },
    status: 'success',
  },
  {
    id: 'claude',
    name: 'mcp__github__list_pull_request_review_threads',
    input: { pr: 123 },
    status: 'success',
  },
  {
    id: 'custom',
    name: 'mcp__my_server__fetchBuildStatus',
    input: { id: 'build-42' },
    status: 'success',
  },
  {
    id: 'playwright',
    name: 'mcp__playwright__browser_take_screenshot',
    input: {},
    status: 'pending',
  },
  {
    id: 'failed',
    name: 'mcp.acme.lookupCustomer',
    input: { id: 'customer-7' },
    status: 'error',
    result: { content: 'Customer not found', isError: true },
  },
];

const meta = {
  title: 'Chat/Tools/McpTools',
  component: ToolSequenceGroup,
  parameters: { layout: 'padded' },
  args: { sequence: { type: 'tool_sequence', id: 'mcp-example', pairedCalls: calls } },
} satisfies Meta<typeof ToolSequenceGroup>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Collapsed: Story = {};
export const Expanded: Story = { args: { defaultOpen: true } };
export const LongUnknownTool: Story = {
  args: {
    defaultOpen: true,
    sequence: {
      type: 'tool_sequence',
      id: 'long-tool',
      pairedCalls: [
        {
          id: 'long',
          name: 'mcp__custom_integration__fetch_all_deployment_statuses_for_the_current_production_environment',
          input: {},
          status: 'success',
        },
      ],
    },
  },
};
