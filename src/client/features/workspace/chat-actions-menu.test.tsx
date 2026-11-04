// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ChatActionsMenu } from './chat-actions-menu';

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

async function openMenu(props: { chatLabel: string | null; disabled?: boolean }) {
  const onRestartSession = vi.fn();
  await act(() =>
    root.render(
      <TooltipProvider>
        <ChatActionsMenu {...props} onRestartSession={onRestartSession} />
      </TooltipProvider>
    )
  );
  await act(() =>
    container
      .querySelector('[aria-label="Chat actions"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  );
  const restart = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) =>
    item.textContent?.startsWith('Restart agent')
  )!;
  return { restart, onRestartSession };
}

it('restarts the selected chat from the chat actions menu', async () => {
  const { restart, onRestartSession } = await openMenu({ chatLabel: 'Chat 2' });
  expect(document.body.textContent).toContain('Chat 2');
  await act(() => restart.click());
  expect(onRestartSession).toHaveBeenCalledOnce();
});

it.each([{ chatLabel: null }, { chatLabel: 'Chat 1', disabled: true }])(
  'disables Restart without a chat or while the tab bar is busy: %o',
  async (props) => {
    const { restart } = await openMenu(props);
    expect(restart.getAttribute('aria-disabled')).toBe('true');
  }
);
