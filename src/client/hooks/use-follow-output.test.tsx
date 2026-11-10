// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFollowOutput } from './use-follow-output';

function Log({ lines }: { lines: string[] }) {
  const followRef = useFollowOutput();
  return createElement('div', { ref: followRef }, createElement('pre', null, lines.join('\n')));
}

/** jsdom has no layout: size the log from its line count, 20px per line in a 100px view. */
function sizeLog(element: HTMLElement) {
  Object.defineProperty(element, 'clientHeight', { configurable: true, value: 100 });
  Object.defineProperty(element, 'scrollHeight', {
    configurable: true,
    get: () => Math.max(100, (element.textContent?.split('\n').length ?? 0) * 20),
  });
}

function userScrollTo(element: HTMLElement, top: number) {
  element.scrollTop = top;
  element.dispatchEvent(new Event('scroll'));
}

const lines = (count: number) => Array.from({ length: count }, (_, index) => `line ${index}`);

let root: Root | null = null;

/** Mounts a log; awaiting a render also runs the mutation observer's queued callback. */
async function mountLog(count: number) {
  const container = document.createElement('div');
  document.body.append(container);
  const mounted = createRoot(container);
  root = mounted;
  const render = (next: number) =>
    act(() => mounted.render(createElement(Log, { lines: lines(next) })));
  await render(count);
  const log = container.firstElementChild as HTMLElement;
  sizeLog(log);
  return { log, render };
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('useFollowOutput', () => {
  it('follows new output only while the reader is at the end', async () => {
    const { log, render } = await mountLog(10);

    await render(20);
    expect(log.scrollTop).toBe(400);

    userScrollTo(log, 120);
    await render(30);
    expect(log.scrollTop).toBe(120);

    userScrollTo(log, 500);
    await render(40);
    expect(log.scrollTop).toBe(800);
  });

  it('does not pull back a scroll up whose scroll event has not arrived yet', async () => {
    const { log, render } = await mountLog(10);
    await render(20);
    expect(log.scrollTop).toBe(400);

    log.scrollTop = 150;
    await render(30);
    expect(log.scrollTop).toBe(150);
  });

  it('keeps following through a smooth scroll that has not reached the end yet', async () => {
    const { log, render } = await mountLog(5);
    // With scroll-behavior: smooth, assigning scrollTop only sets the target.
    let position = 0;
    let target = 0;
    Object.defineProperty(log, 'scrollTop', {
      configurable: true,
      get: () => position,
      set: (value: number) => {
        target = value;
      },
    });
    const animateTo = (top: number) => {
      position = top;
      log.dispatchEvent(new Event('scroll'));
    };

    await render(20);
    expect(target).toBe(400);
    animateTo(150);
    animateTo(250);
    await render(30);
    expect(target).toBe(600);

    animateTo(200);
    await render(40);
    expect(target).toBe(600);
  });
});
