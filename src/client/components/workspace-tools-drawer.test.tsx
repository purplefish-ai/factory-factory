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
  Reflect.deleteProperty(navigator, 'windowControlsOverlay');
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
  // The keyboard can disappear while the closed drawer isn't listening.
  viewport.height = 882;
  viewport.offsetTop = 0;
  let heightAtFocus = '';
  const captureReopenHeight = () => {
    if (heightAtFocus) {
      return;
    }
    heightAtFocus = document.querySelector<HTMLElement>('[role="dialog"]')?.style.height ?? '';
  };
  document.addEventListener('focusin', captureReopenHeight);
  await act(() => opener.click());
  document.removeEventListener('focusin', captureReopenHeight);
  expect(heightAtFocus).toBe('882px');
  await act(() => root.unmount());
});

it('keeps the drawer below native controls while preserving a lower keyboard viewport offset', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const viewport = Object.assign(new EventTarget(), { height: 882, offsetTop: 0 });
  vi.stubGlobal('visualViewport', viewport);
  const overlay = Object.assign(new EventTarget(), {
    visible: true,
    getTitlebarAreaRect: () => new DOMRect(86, 0, 700, 32),
  });
  Object.defineProperty(navigator, 'windowControlsOverlay', { configurable: true, value: overlay });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(() => root.render(<Session />));
    await act(() => container.querySelector('button')!.click());
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.style.top).toBe('32px');
    expect(dialog.style.height).toBe('850px');
    await act(() => {
      viewport.height = 420;
      viewport.offsetTop = 60;
      viewport.dispatchEvent(new Event('resize'));
    });
    expect(dialog.style.top).toBe('60px');
    expect(dialog.style.height).toBe('420px');
    await act(() => {
      viewport.offsetTop = 12;
      viewport.dispatchEvent(new Event('scroll'));
    });
    expect(dialog.style.top).toBe('32px');
    expect(dialog.style.height).toBe('400px');
    await act(() => {
      overlay.visible = false;
      overlay.dispatchEvent(new Event('geometrychange'));
    });
    expect(dialog.style.top).toBe('12px');
    expect(dialog.style.height).toBe('420px');
  } finally {
    await act(() => root.unmount());
  }
});
