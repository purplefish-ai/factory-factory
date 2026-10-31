// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceToolsDrawer } from './workspace-tools-drawer';

function Session() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Tools
      </button>
      <WorkspaceToolsDrawer open={open} onOpenChange={setOpen}>
        <textarea aria-label="Terminal input" />
      </WorkspaceToolsDrawer>
    </>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

it('fits the visible viewport above the keyboard and restores focus to the opener on close', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const viewport = Object.assign(new EventTarget(), { height: 882, offsetTop: 0 });
  vi.stubGlobal('visualViewport', viewport);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(() => root.render(<Session />));
  const opener = container.querySelector('button')!;
  opener.focus();
  await act(() => opener.click());
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(document.activeElement?.textContent).toBe('Workspace tools');
  expect(dialog.style.height).toBe('882px');
  const terminalInput = dialog.querySelector('textarea')!;
  terminalInput.focus();
  await act(() => {
    viewport.height = 420;
    viewport.offsetTop = 12;
    viewport.dispatchEvent(new Event('resize'));
  });
  expect(dialog.style.height).toBe('420px');
  expect(dialog.style.top).toBe('12px');
  await act(() =>
    dialog.querySelector<HTMLButtonElement>('[data-slot="sheet-content"] > button, button')?.click()
  );
  // Radix dispatches unmount autofocus on the next timer tick.
  await vi.waitFor(() => expect(document.activeElement).toBe(opener));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await act(() => root.unmount());
});
