// @vitest-environment jsdom

import { act, createRef, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Button } from './button';
import { CommandDialog, CommandInput, CommandList } from './command';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from './dialog';
import { PopoverTitle } from './popover';
import { ScrollArea } from './scroll-area';
import { Slider } from './slider';

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

describe('refreshed UI primitives', () => {
  it('exposes popover titles as headings and forwards their heading refs', async () => {
    const ref = createRef<HTMLHeadingElement>();
    await render(<PopoverTitle ref={ref}>Workspace details</PopoverTitle>);
    const heading = container.querySelector('h2');
    expect(heading?.textContent).toBe('Workspace details');
    expect(ref.current).toBe(heading);
  });

  it('defaults to one keyboard-operable slider thumb at the minimum', async () => {
    await render(<Slider min={10} max={20} />);
    const thumbs = container.querySelectorAll<HTMLElement>('[role=slider]');
    expect(thumbs).toHaveLength(1);
    expect(thumbs[0]?.getAttribute('aria-valuenow')).toBe('10');
    await act(() => {
      thumbs[0]!.focus();
      thumbs[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(thumbs[0]?.getAttribute('aria-valuenow')).toBe('11');
  });

  it('exposes the scrolling viewport and delivers its scroll events to file viewers', async () => {
    const viewportRef = createRef<HTMLDivElement>();
    const rootRef = createRef<HTMLDivElement>();
    const onScroll = vi.fn();
    await render(
      <ScrollArea ref={rootRef} viewportRef={viewportRef} onScroll={onScroll} scrollbars="both">
        <p>File contents</p>
      </ScrollArea>
    );
    expect(viewportRef.current).not.toBeNull();
    expect(viewportRef.current).not.toBe(rootRef.current);
    expect(viewportRef.current?.textContent).toBe('File contents');
    await act(() => viewportRef.current!.dispatchEvent(new Event('scroll')));
    expect(onScroll).toHaveBeenCalledOnce();
  });
  it('renders both endpoints of a range slider and updates them from controlled values', async () => {
    await render(<Slider value={[20, 80]} />);
    expect(
      Array.from(container.querySelectorAll('[role=slider]'), (thumb) =>
        thumb.getAttribute('aria-valuenow')
      )
    ).toEqual(['20', '80']);
    await render(<Slider value={[30, 70]} />);
    expect(
      Array.from(container.querySelectorAll('[role=slider]'), (thumb) =>
        thumb.getAttribute('aria-valuenow')
      )
    ).toEqual(['30', '70']);
  });

  it('keeps a single thumb for the volume controls', async () => {
    await render(<Slider defaultValue={[50]} min={0} max={100} aria-label="Volume" />);
    expect(container.querySelectorAll('[role=slider]')).toHaveLength(1);
    expect(container.querySelector('[role=slider]')?.getAttribute('aria-valuenow')).toBe('50');
  });

  it('can hide the corner close control and close through the dialog footer', async () => {
    const onOpenChange = vi.fn();
    await render(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent showCloseButton={false}>
          <DialogTitle>Preferences</DialogTitle>
          <DialogDescription>Configure your workspace.</DialogDescription>
          <DialogFooter showCloseButton />
        </DialogContent>
      </Dialog>
    );
    const dialog = document.querySelector('[role=dialog]');
    const closeButtons = dialog?.querySelectorAll('button');
    expect(closeButtons).toHaveLength(1);
    expect(dialog?.querySelector('[data-slot=dialog-footer]')?.contains(closeButtons![0]!)).toBe(
      true
    );
    await act(() => closeButtons![0]!.click());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('provides an accessible command dialog name and description inside the modal', async () => {
    await render(
      <CommandDialog open title="Workspace commands" description="Find an action.">
        <CommandInput />
        <CommandList />
      </CommandDialog>
    );
    const dialog = document.querySelector('[role=dialog]')!;
    const title = document.getElementById(dialog.getAttribute('aria-labelledby')!);
    const description = document.getElementById(dialog.getAttribute('aria-describedby')!);
    expect(title?.textContent).toBe('Workspace commands');
    expect(description?.textContent).toBe('Find an action.');
    expect(dialog.contains(title)).toBe(true);
    expect(dialog.contains(description)).toBe(true);
  });

  it('preserves refs and click handlers when a button renders a link', async () => {
    const ref = createRef<HTMLButtonElement>();
    const onClick = vi.fn((event: React.MouseEvent) => event.preventDefault());
    await render(
      <Button ref={ref} asChild onClick={onClick}>
        <a href="/settings">Settings</a>
      </Button>
    );
    const link = container.querySelector('a')!;
    expect(ref.current).toBe(link);
    await act(() => link.click());
    expect(onClick).toHaveBeenCalledOnce();
  });
});
