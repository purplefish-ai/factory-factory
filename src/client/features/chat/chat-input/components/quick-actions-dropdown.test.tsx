// @vitest-environment jsdom
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type QuickActionOption,
  QuickActionsDropdownView,
  resolveQuickActionTarget,
} from './quick-actions-dropdown';

const ACTIONS: QuickActionOption[] = [
  {
    id: 'create-pr',
    name: 'Create Pull Request',
    description: 'Open a pull request for this branch',
    icon: 'git-pull-request',
    content: 'Create a pull request',
  },
  { id: 'review', name: 'Review', description: 'Review the changes', content: 'Review it' },
];

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // Tooltips reopen when focus returns to their trigger after a menu closes.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {
        // jsdom does no layout.
      }
      unobserve() {
        // jsdom does no layout.
      }
      disconnect() {
        // jsdom does no layout.
      }
    }
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

type Props = ComponentProps<typeof QuickActionsDropdownView>;
async function openMenu(props: Partial<Props> = {}) {
  const onRunInThisChat = vi.fn();
  await act(() =>
    root.render(
      <QuickActionsDropdownView
        actions={ACTIONS}
        status="ready"
        onRunInThisChat={onRunInThisChat}
        {...props}
      />
    )
  );
  const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Quick actions"]')!;
  if (!trigger.disabled) {
    await act(() =>
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    );
  }
  return { trigger, onRunInThisChat };
}
const menuItems = (role: string) => [...document.querySelectorAll<HTMLElement>(`[role="${role}"]`)];
const item = (name: string) => menuItems('menuitem').find((el) => el.textContent?.includes(name))!;
const radio = (name: string) => menuItems('menuitemradio').find((el) => el.textContent === name)!;

describe('quick actions menu', () => {
  it('sends an action into this chat by default', async () => {
    const onRunInNewChat = vi.fn();
    const { onRunInThisChat } = await openMenu({ onRunInNewChat });
    expect(radio('Run in this chat').getAttribute('aria-checked')).toBe('true');
    await act(() => item('Create Pull Request').click());
    expect(onRunInThisChat).toHaveBeenCalledWith('Create a pull request');
    expect(onRunInNewChat).not.toHaveBeenCalled();
  });

  it('starts a new chat named after the action once "Run in new chat" is chosen', async () => {
    const onRunInNewChat = vi.fn();
    const { onRunInThisChat } = await openMenu({ onRunInNewChat });
    await act(() => radio('Run in new chat').click());
    // Choosing a target keeps the menu open so the action can be picked next.
    expect(radio('Run in new chat').getAttribute('aria-checked')).toBe('true');
    await act(() => item('Review').click());
    expect(onRunInNewChat).toHaveBeenCalledWith('Review', 'Review it');
    expect(onRunInThisChat).not.toHaveBeenCalled();
  });

  it('keeps an explicit new-chat target when its availability changes', async () => {
    const onRunInNewChat = vi.fn();
    const onRunInThisChat = vi.fn();
    await openMenu({ onRunInNewChat, onRunInThisChat });
    await act(() => radio('Run in new chat').click());
    await act(() =>
      root.render(
        <QuickActionsDropdownView
          actions={ACTIONS}
          status="ready"
          onRunInNewChat={onRunInNewChat}
          onRunInThisChat={onRunInThisChat}
          newChatUnavailableReason="Maximum sessions reached"
        />
      )
    );
    expect(radio('Run in new chat').getAttribute('aria-checked')).toBe('true');
    expect(item('Review').getAttribute('aria-disabled')).toBe('true');
    await act(() => item('Review').click());
    expect(onRunInThisChat).not.toHaveBeenCalled();
    expect(onRunInNewChat).not.toHaveBeenCalled();
  });

  it('disables open actions when both targets become unavailable', async () => {
    const onRunInThisChat = vi.fn();
    await openMenu({ onRunInThisChat });
    await act(() =>
      root.render(
        <QuickActionsDropdownView
          actions={ACTIONS}
          status="ready"
          onRunInThisChat={onRunInThisChat}
          thisChatDisabled
        />
      )
    );
    expect(item('Review').getAttribute('aria-disabled')).toBe('true');
    await act(() => item('Review').click());
    expect(onRunInThisChat).not.toHaveBeenCalled();
  });

  it('only offers this chat where new chats are not supported', async () => {
    await openMenu();
    expect(menuItems('menuitemradio')).toHaveLength(0);
    expect(item('Review')).toBeDefined();
  });

  it('explains and disables "Run in new chat" while a new chat cannot start', async () => {
    await openMenu({
      onRunInNewChat: vi.fn(),
      newChatUnavailableReason: 'A new chat is starting.',
    });
    expect(radio('Run in new chat').getAttribute('aria-disabled')).toBe('true');
    expect(document.body.textContent).toContain('A new chat is starting.');
  });

  it('runs in a new chat while this chat is disconnected, and disables only when neither can', async () => {
    const onRunInNewChat = vi.fn();
    await openMenu({ onRunInNewChat, thisChatDisabled: true });
    expect(radio('Run in new chat').getAttribute('aria-checked')).toBe('true');
    await act(() => item('Review').click());
    expect(onRunInNewChat).toHaveBeenCalledWith('Review', 'Review it');

    const { trigger } = await openMenu({
      onRunInNewChat,
      thisChatDisabled: true,
      newChatUnavailableReason: 'Loading chats…',
    });
    expect(trigger.disabled).toBe(true);
  });

  it.each([
    ['loading', 'Loading quick actions…'],
    ['error', "Couldn't load quick actions."],
  ] as const)('shows the %s state inside the menu', async (status, text) => {
    const onRetry = vi.fn();
    await openMenu({ status, onRetry, actions: [] });
    expect(document.body.textContent).toContain(text);
    if (status === 'error') {
      await act(() => item('Retry').click());
      expect(onRetry).toHaveBeenCalledOnce();
    }
  });
});

describe('quick action target fallback', () => {
  it.each([
    ['this-chat', { thisChat: true, newChat: true }, 'this-chat'],
    ['this-chat', { thisChat: false, newChat: true }, 'new-chat'],
    ['new-chat', { thisChat: true, newChat: false }, 'this-chat'],
    ['new-chat', { thisChat: true, newChat: true }, 'new-chat'],
  ] as const)('%s with %o runs in %s', (chosen, available, expected) => {
    expect(resolveQuickActionTarget(chosen, available)).toBe(expected);
  });
});
