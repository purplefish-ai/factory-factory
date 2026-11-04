// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FactoryUpdateBanner } from './factory-update-banner';

const state = vi.hoisted(() => ({
  data: undefined as
    | undefined
    | { currentVersion: string; latestVersion: string | null; updateAvailable: boolean },
}));
vi.mock('@/client/lib/trpc', () => ({
  trpc: { admin: { checkFactoryUpdate: { useQuery: () => ({ data: state.data }) } } },
}));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  state.data = { currentVersion: '0.5.3', latestVersion: '0.6.0', updateAvailable: true };
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});
const render = () => act(() => root.render(<FactoryUpdateBanner />));

it('offers an upgrade link for a newer version', async () => {
  await render();
  expect(container.textContent).toContain('Factory Factory 0.6.0 is available');
  expect(container.querySelector('a')?.href).toBe(
    'https://github.com/purplefish-ai/factory-factory#updating'
  );
});
it('persists dismissal across remounts but shows subsequent releases', async () => {
  await render();
  await act(() => container.querySelector('button')?.click());
  expect(container.textContent).toBe('');
  await act(() => root.unmount());
  root = createRoot(container);
  await render();
  expect(container.textContent).toBe('');
  state.data!.latestVersion = '0.7.0';
  await render();
  expect(container.textContent).toContain('0.7.0');
});
it.each([
  undefined,
  { currentVersion: '0.5.3', latestVersion: null, updateAvailable: false },
  { currentVersion: '0.5.3', latestVersion: '0.5.3', updateAvailable: false },
])('renders nothing without an available update', async (data) => {
  state.data = data;
  await render();
  expect(container.textContent).toBe('');
});
it('stays dismissible when browser storage is unavailable', async () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  try {
    await render();
    await act(() => container.querySelector('button')?.click());
    expect(container.textContent).toBe('');
  } finally {
    vi.restoreAllMocks();
  }
});
