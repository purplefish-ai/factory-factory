// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useOverlayPositioning } from './use-overlay-positioning';

let root: Root;
let container: HTMLDivElement;
let overlay: EventTarget & { visible: boolean; getTitlebarAreaRect: () => DOMRect };
let height: number;

function Preview({
  padding = 8,
  sticky,
}: {
  padding?: Parameters<typeof useOverlayPositioning>[0];
  sticky?: 'partial' | 'always';
}) {
  return <output>{JSON.stringify(useOverlayPositioning(padding, sticky))}</output>;
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
  expect(container.textContent).toBe(
    '{"collisionPadding":{"top":44,"right":8,"bottom":8,"left":8},"sticky":"always"}'
  );
  height = 48;
  await act(() => overlay.dispatchEvent(new Event('geometrychange')));
  expect(container.textContent).toBe(
    '{"collisionPadding":{"top":60,"right":8,"bottom":8,"left":8},"sticky":"always"}'
  );
  overlay.visible = false;
  await act(() => overlay.dispatchEvent(new Event('geometrychange')));
  expect(container.textContent).toBe('{"collisionPadding":8,"sticky":"partial"}');
});

it('preserves per-side collision margins', async () => {
  await act(() => root.render(<Preview padding={{ top: 12, left: 20 }} />));
  expect(container.textContent).toBe('{"collisionPadding":{"top":48,"left":20},"sticky":"always"}');
});

it('preserves normal browser placement when the API is unavailable', async () => {
  Reflect.deleteProperty(navigator, 'windowControlsOverlay');
  await act(() => root.render(<Preview />));
  expect(container.textContent).toBe('{"collisionPadding":8,"sticky":"partial"}');
});

it('preserves caller stickiness in a normal browser', async () => {
  overlay.visible = false;
  await act(() => root.render(<Preview sticky="always" />));
  expect(container.textContent).toBe('{"collisionPadding":8,"sticky":"always"}');
});
