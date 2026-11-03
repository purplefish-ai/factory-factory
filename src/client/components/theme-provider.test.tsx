// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from './theme-provider';

let root: Root;
let meta: HTMLMetaElement;

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: false,
      addListener: vi.fn(),
      removeListener: vi.fn(),
    }))
  );
  document.body.style.backgroundColor = 'rgb(240, 240, 240)';
  meta = document.createElement('meta');
  meta.name = 'theme-color';
  document.head.append(meta);
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(() =>
    root.render(
      <ThemeProvider>
        <div />
      </ThemeProvider>
    )
  );
});

afterEach(async () => {
  await act(() => root.unmount());
  document.body.innerHTML = '';
  document.body.removeAttribute('style');
  document.documentElement.removeAttribute('data-color-scheme');
  meta.remove();
  vi.unstubAllGlobals();
});

async function addOverlay(slot = 'dialog-overlay') {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `<div data-slot="${slot}" data-state="open"></div>`;
  await act(() => document.body.append(wrapper));
  return wrapper;
}

describe('ThemeProvider browser chrome', () => {
  it.each(['dialog-overlay', 'alert-dialog-overlay', 'sheet-overlay'])(
    'dims the native background for %s and restores it on removal',
    async (slot) => {
      expect(meta.content).toBe('rgb(240, 240, 240)');
      const overlay = await addOverlay(slot);
      expect(meta.content).toBe('color(srgb 0.470588 0.470588 0.470588)');
      // Radix keeps the backdrop mounted during its closing animation.
      await act(() => overlay.firstElementChild?.setAttribute('data-state', 'closed'));
      expect(meta.content).toBe('color(srgb 0.470588 0.470588 0.470588)');
      await act(() => overlay.remove());
      expect(meta.content).toBe('rgb(240, 240, 240)');
    }
  );

  it('composites stacked dialog and alert backdrops independently', async () => {
    const first = await addOverlay();
    const second = await addOverlay('alert-dialog-overlay');
    expect(meta.content).toBe('color(srgb 0.235294 0.235294 0.235294)');
    await act(() => first.remove());
    expect(meta.content).toBe('color(srgb 0.470588 0.470588 0.470588)');
    await act(() => second.remove());
    expect(meta.content).toBe('rgb(240, 240, 240)');
  });

  it('follows live appearance changes while dimmed and restores the latest color', async () => {
    const overlay = await addOverlay();
    await act(() => {
      document.body.style.backgroundColor = 'rgb(20, 40, 60)';
      document.documentElement.setAttribute('data-color-scheme', 'custom');
    });
    expect(meta.content).toBe('color(srgb 0.0392157 0.0784314 0.117647)');
    await act(() => overlay.remove());
    expect(meta.content).toBe('rgb(20, 40, 60)');
  });
});
