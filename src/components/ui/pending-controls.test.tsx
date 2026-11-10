// @vitest-environment jsdom

import { PlusIcon } from '@phosphor-icons/react/dist/csr/Plus';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Button } from './button';
import { Card } from './card';
import { ConfirmDialog } from './confirm-dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from './dropdown-menu';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
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

async function render(children: ReactNode) {
  await act(() => root.render(children));
}

function button(): HTMLButtonElement {
  const element = container.querySelector('button');
  if (!element) {
    throw new Error('No button rendered');
  }
  return element;
}

describe('Button pending', () => {
  it('renders children unchanged when idle', async () => {
    await render(
      <Button>
        <PlusIcon />
        Save
      </Button>
    );
    expect(button().disabled).toBe(false);
    expect(button().hasAttribute('aria-busy')).toBe(false);
    expect(button().querySelector('[data-slot=spinner]')).toBeNull();
    expect(button().textContent).toBe('Save');
  });

  it('disables, marks busy and puts a hidden spinner beside the label', async () => {
    const onClick = vi.fn();
    await render(
      <Button pending onClick={onClick}>
        <PlusIcon />
        Save
      </Button>
    );
    const spinner = button().querySelector('[data-slot=spinner]');
    expect(button().disabled).toBe(true);
    expect(button().getAttribute('aria-busy')).toBe('true');
    expect(spinner?.getAttribute('aria-hidden')).toBe('true');
    expect(button().firstElementChild).toBe(spinner);
    expect(button().textContent).toBe('Save');
    // The static icon is hidden so the spinner takes its place.
    expect(button().className).toContain("[&>svg:not([data-slot='spinner'])]:hidden");
    // No size class: the button's svg sizing applies to the spinner.
    expect(spinner?.getAttribute('class')).not.toMatch(/(^|\s)size-/);
    await act(() => button().click());
    expect(onClick).not.toHaveBeenCalled();
  });

  it('swaps the label for pendingLabel', async () => {
    await render(
      <Button pending pendingLabel="Saving…">
        Save
      </Button>
    );
    expect(button().textContent).toBe('Saving…');
  });

  it('keeps icon buttons named and uses pendingLabel as their accessible name', async () => {
    await render(
      <Button size="icon" aria-label="Start dev server" pending pendingLabel="Starting dev server">
        <PlusIcon />
      </Button>
    );
    expect(button().getAttribute('aria-label')).toBe('Starting dev server');
    expect(button().className).toContain("[&>:not([data-slot='spinner'],.sr-only)]:hidden");

    await render(
      <Button size="icon" pending>
        <PlusIcon />
        <span className="sr-only">Add workspace</span>
      </Button>
    );
    expect(button().textContent).toBe('Add workspace');
  });

  it('keeps an explicitly disabled button disabled when idle', async () => {
    await render(<Button disabled>Save</Button>);
    expect(button().disabled).toBe(true);
    expect(button().hasAttribute('aria-busy')).toBe(false);
  });
});

describe('DropdownMenuItem pending', () => {
  it('disables the item and swaps its icon for a spinner', async () => {
    const onSelect = vi.fn();
    await render(
      <DropdownMenu open>
        <DropdownMenuContent>
          <DropdownMenuItem pending onSelect={onSelect}>
            <PlusIcon />
            Sync now
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
    const item = document.body.querySelector<HTMLElement>('[data-slot=dropdown-menu-item]');
    expect(item?.getAttribute('aria-busy')).toBe('true');
    expect(item?.hasAttribute('data-disabled')).toBe(true);
    expect(item?.firstElementChild?.getAttribute('data-slot')).toBe('spinner');
    expect(item?.className).toContain("[&>svg:not([data-slot='spinner'])]:hidden");
    await act(() => item?.click());
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('ConfirmDialog', () => {
  function renderDialog(props: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) {
    const onOpenChange = vi.fn();
    const onConfirm = vi.fn();
    const view = render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Delete agent?"
        description="This cannot be undone."
        confirmText="Delete"
        variant="destructive"
        onConfirm={onConfirm}
        {...props}
      />
    );
    return { view, onOpenChange, onConfirm };
  }

  function dialogButton(name: string): HTMLButtonElement {
    const match = [...document.body.querySelectorAll('button')].find(
      (element) => element.textContent === name
    );
    if (!match) {
      throw new Error(`No ${name} button`);
    }
    return match;
  }

  function pressEscape() {
    document.body
      .querySelector('[role=alertdialog]')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  }

  it('runs onConfirm without closing, and closes on Escape when idle', async () => {
    const { view, onOpenChange, onConfirm } = renderDialog();
    await view;
    await act(() => dialogButton('Delete').click());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
    await act(() => pressEscape());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('keeps the label beside the spinner and refuses to close while pending', async () => {
    const { view, onOpenChange } = renderDialog({ isPending: true, pendingText: 'Deleting…' });
    await view;
    const confirm = dialogButton('Deleting…');
    expect(confirm.disabled).toBe(true);
    expect(confirm.getAttribute('aria-busy')).toBe('true');
    expect(confirm.querySelector('[data-slot=spinner]')).not.toBeNull();
    expect(dialogButton('Cancel').disabled).toBe(true);
    await act(() => pressEscape());
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('renders extra body content and a secondary action', async () => {
    const onRetry = vi.fn();
    const { view } = renderDialog({
      children: <p>Two child workspaces stay active.</p>,
      secondaryAction: { label: 'Retry', onClick: onRetry },
    });
    await view;
    expect(document.body.textContent).toContain('Two child workspaces stay active.');
    await act(() => dialogButton('Retry').click());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('does not bubble dialog clicks to the component that rendered it', async () => {
    const onParentClick = vi.fn();
    await render(
      // A clickable Kanban card renders the archive dialog this way.
      <Card onClick={onParentClick}>
        <ConfirmDialog
          open
          onOpenChange={vi.fn()}
          title="Archive workspace?"
          description="Running agents stop."
          onConfirm={vi.fn()}
        />
      </Card>
    );
    await act(() => dialogButton('Continue').click());
    expect(onParentClick).not.toHaveBeenCalled();
  });
});
