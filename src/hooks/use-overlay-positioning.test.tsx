// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useOverlayPositioning } from './use-overlay-positioning';

let root: Root;
let container: HTMLDivElement;
let overlay: EventTarget & { visible: boolean; getTitlebarAreaRect: () => DOMRect };
let height: number;

function Preview({ padding = 8 }: { padding?: Parameters<typeof useOverlayPositioning>[0] }) {
  return <output>{JSON.stringify(useOverlayPositioning(padding).collisionPadding)}</output>;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  height = 32;
  overlay = Object.assign(new EventTarget(), {
    visible: true,
    getTitlebarAreaRect: () => new DOMRect(86, 4, 700, height),
  });
  Object.defineProperty(navigator, 'windowControlsOverlay', { configurable: true, value: overlay });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  Reflect.deleteProperty(navigator, 'windowControlsOverlay');
  vi.unstubAllGlobals();
});

it('adds the native title bar to the caller padding and follows geometry changes', async () => {
  await act(() => root.render(<Preview />));
  expect(container.textContent).toBe('{"top":44,"right":8,"bottom":8,"left":8}');
  height = 48;
  await act(() => overlay.dispatchEvent(new Event('geometrychange')));
  expect(container.textContent).toBe('{"top":60,"right":8,"bottom":8,"left":8}');
  overlay.visible = false;
  await act(() => overlay.dispatchEvent(new Event('geometrychange')));
  expect(container.textContent).toBe('8');
});

it('preserves per-side collision margins', async () => {
  await act(() => root.render(<Preview padding={{ top: 12, left: 20 }} />));
  expect(container.textContent).toBe('{"top":48,"left":20}');
});

it('preserves normal browser placement when the API is unavailable', async () => {
  Reflect.deleteProperty(navigator, 'windowControlsOverlay');
  await act(() => root.render(<Preview />));
  expect(container.textContent).toBe('8');
});
