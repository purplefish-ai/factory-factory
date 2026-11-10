// @vitest-environment jsdom
import { XIcon } from '@phosphor-icons/react/dist/csr/X';
import { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { IconButton } from './icon-button';

const roots: ReturnType<typeof createRoot>[] = [];

function render(element: React.ReactElement) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(<TooltipProvider delayDuration={0}>{element}</TooltipProvider>));
  return container;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount());
  }
  document.body.replaceChildren();
});

// Opening the tooltip needs layout (ResizeObserver); the Shared/IconButton story covers it.
it('names the button with its label and defaults to a ghost icon button', () => {
  const container = render(
    <IconButton label="Close panel">
      <XIcon />
    </IconButton>
  );
  const button = container.querySelector('button');
  expect(button?.getAttribute('aria-label')).toBe('Close panel');
  expect(button?.dataset.size).toBe('icon');
  expect(button?.dataset.variant).toBe('ghost');
  expect(button?.hasAttribute('title')).toBe(false);
});

it('forwards its ref and handlers to the button', () => {
  const ref = createRef<HTMLButtonElement>();
  const onClick = vi.fn();
  const container = render(
    <IconButton ref={ref} label="Close panel" onClick={onClick}>
      <XIcon />
    </IconButton>
  );
  const button = container.querySelector('button');
  expect(ref.current).toBe(button);
  act(() => button?.click());
  expect(onClick).toHaveBeenCalledTimes(1);
});

it('uses the pending label as its name while pending', () => {
  const container = render(
    <IconButton label="Run" pending pendingLabel="Running">
      <XIcon />
    </IconButton>
  );
  const button = container.querySelector('button');
  expect(button?.getAttribute('aria-label')).toBe('Running');
  expect(button?.disabled).toBe(true);
});

it('keeps one wrapper for a tooltip while disabled, so pending does not remount the button', () => {
  const ref = createRef<HTMLButtonElement>();
  const element = (pending: boolean) => (
    <TooltipProvider delayDuration={0}>
      <IconButton ref={ref} label="Stop agent" tooltipWhileDisabled pending={pending}>
        <XIcon />
      </IconButton>
    </TooltipProvider>
  );
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(element(false)));
  const button = container.querySelector('button');
  expect(button?.parentElement?.tagName).toBe('SPAN');
  expect(ref.current).toBe(button);

  act(() => root.render(element(true)));
  expect(container.querySelector('button')).toBe(button);
  expect(button?.disabled).toBe(true);
});
