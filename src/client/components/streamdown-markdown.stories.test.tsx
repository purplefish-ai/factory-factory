// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import comparison from './streamdown-markdown.stories';

const Comparison = comparison.component;
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));
const render = () =>
  act(() =>
    root.render(
      <Comparison content={'0123456789'.repeat(10)} chunks={[1, 2, 3, 4]} snapshotMs={100} />
    )
  );
const status = () => container.querySelector('[aria-live="off"]')?.textContent;
const click = (label: string) =>
  act(() => {
    const button = [...container.querySelectorAll('button')].find(
      (node) => node.textContent === label
    );
    expect(button).toBeDefined();
    button?.click();
  });

it('restarts the burst pattern and snapshot clock during playback', async () => {
  await render();
  await advance(75);
  expect(status()).toContain('6 received');
  await click('Restart');
  expect(status()).toContain('0 received');
  await advance(25);
  expect(status()).toContain('1 received');
  expect(status()).toContain('0 rendered');
  await advance(75);
  expect(status()).toContain('10 rendered');
});

it('resumes from the same burst position after a pause', async () => {
  await render();
  await advance(50);
  expect(status()).toContain('3 received');
  await click('Pause');
  await advance(200);
  expect(status()).toContain('3 received');
  await click('Resume');
  await advance(25);
  expect(status()).toContain('6 received');
});

it('finishes both panes immediately and can restart a completed replay', async () => {
  await render();
  await click('Finish now');
  expect(status()).toContain('100 received · 100 rendered · Complete');
  const panes = [...container.querySelectorAll('section > div')];
  expect(panes.map((pane) => pane.textContent)).toEqual([
    '0123456789'.repeat(10),
    '0123456789'.repeat(10),
  ]);
  await click('Restart');
  expect(status()).toContain('0 received · 0 rendered · Streaming');
});

it('replays word fades after restarting a previously streamed response', async () => {
  await render();
  await advance(100);
  expect(
    container
      .querySelector<HTMLElement>('[data-sd-animate]')
      ?.style.getPropertyValue('--sd-duration')
  ).toBe('120ms');
  await click('Finish now');
  await click('Restart');
  await advance(100);
  expect(
    container
      .querySelector<HTMLElement>('[data-sd-animate]')
      ?.style.getPropertyValue('--sd-duration')
  ).toBe('120ms');
});
