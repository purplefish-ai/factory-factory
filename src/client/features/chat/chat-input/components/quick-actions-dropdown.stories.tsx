import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { type QuickActionOption, QuickActionsDropdownView } from './quick-actions-dropdown';

// Mirrors prompts/quick-actions/, the catalog the composer menu loads.
const ACTIONS: QuickActionOption[] = [
  {
    id: 'address-pr-comments',
    name: 'Address PR Comments',
    description: 'Fetch review comments and address the feedback',
    icon: 'chat-text',
    content: 'Address the PR comments.',
  },
  {
    id: 'create-pr',
    name: 'Create Pull Request',
    description: 'Open a pull request for this branch',
    icon: 'git-pull-request',
    content: 'Create a pull request.',
  },
  {
    id: 'fetch-rebase',
    name: 'Fetch & Rebase',
    description: 'Fetch latest from origin and rebase onto the base branch',
    icon: 'git-branch',
    content: 'Fetch and rebase.',
  },
  {
    id: 'review',
    name: 'Review',
    description: 'Review the current changes',
    icon: 'eye',
    content: 'Review the changes.',
  },
  {
    id: 'simplify',
    name: 'Simplify',
    description: 'Simplify and refine recent code changes',
    icon: 'sparkles',
    content: 'Simplify the changes.',
  },
];

const meta = {
  title: 'Chat/Input/QuickActionsMenu',
  component: QuickActionsDropdownView,
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        component:
          'The composer\'s ⚡ menu, the one place to run a quick action. "Run in this chat" sends the prompt into the current chat; "Run in new chat" starts a chat named after the action. Actions come from `prompts/quick-actions/`.',
      },
    },
  },
  args: {
    actions: ACTIONS,
    status: 'ready',
    onRunInThisChat: fn(),
    onRunInNewChat: fn(),
    onRetry: fn(),
  },
  beforeEach: ({ args }) => {
    for (const mock of [args.onRunInThisChat, args.onRunInNewChat, args.onRetry]) {
      if (mock && 'mockClear' in mock && typeof mock.mockClear === 'function') {
        mock.mockClear();
      }
    }
  },
} satisfies Meta<typeof QuickActionsDropdownView>;
export default meta;
type Story = StoryObj<typeof meta>;

const openMenu = async (canvasElement: HTMLElement) => {
  await userEvent.click(within(canvasElement).getByRole('button', { name: 'Quick actions' }));
  return within(canvasElement.ownerDocument.body).findByRole('menu');
};

export const RunInThisChat: Story = {
  play: async ({ args, canvasElement }) => {
    const menu = within(await openMenu(canvasElement));
    await expect(menu.getByRole('menuitemradio', { name: 'Run in this chat' })).toBeChecked();
    await userEvent.click(menu.getByRole('menuitem', { name: /Create Pull Request/ }));
    await expect(args.onRunInThisChat).toHaveBeenCalledWith('Create a pull request.');
  },
};

export const RunInNewChat: Story = {
  play: async ({ args, canvasElement }) => {
    const menu = within(await openMenu(canvasElement));
    await userEvent.click(menu.getByRole('menuitemradio', { name: 'Run in new chat' }));
    await waitFor(() =>
      expect(menu.getByRole('menuitemradio', { name: 'Run in new chat' })).toBeChecked()
    );
    await userEvent.click(menu.getByRole('menuitem', { name: /Review/ }));
    await expect(args.onRunInNewChat).toHaveBeenCalledWith('Review', 'Review the changes.');
  },
};

export const NewChatUnavailable: Story = {
  args: { newChatUnavailableReason: 'This workspace already has the maximum of 5 active chats.' },
  play: async ({ canvasElement }) => {
    const menu = within(await openMenu(canvasElement));
    await expect(menu.getByRole('menuitemradio', { name: 'Run in new chat' })).toHaveAttribute(
      'aria-disabled',
      'true'
    );
    await expect(menu.getByText(/maximum of 5 active chats/)).toBeVisible();
  },
};

/** Quick Chat on the board and other composers without new-chat support. */
export const ThisChatOnly: Story = {
  args: { onRunInNewChat: undefined },
  play: async ({ canvasElement }) => {
    const menu = within(await openMenu(canvasElement));
    await expect(menu.queryByRole('menuitemradio')).toBeNull();
  },
};

export const Loading: Story = {
  args: { status: 'loading', actions: [] },
  play: async ({ canvasElement }) => {
    const menu = within(await openMenu(canvasElement));
    await expect(menu.getByText('Loading quick actions…')).toBeVisible();
  },
};

export const LoadError: Story = {
  args: { status: 'error', actions: [] },
  play: async ({ args, canvasElement }) => {
    const menu = within(await openMenu(canvasElement));
    await userEvent.click(menu.getByRole('menuitem', { name: 'Retry' }));
    await expect(args.onRetry).toHaveBeenCalled();
  },
};

export const Empty: Story = {
  args: { actions: [] },
  play: async ({ canvasElement }) => {
    const menu = within(await openMenu(canvasElement));
    await expect(menu.getByText('No quick actions')).toBeVisible();
  },
};

export const Dark: Story = {
  globals: { theme: 'dark' },
  play: async ({ canvasElement }) => {
    await openMenu(canvasElement);
  },
};

export const Phone: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ({ canvasElement }) => {
    await openMenu(canvasElement);
  },
};
