// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MobileBoardSections } from './mobile-board-sections';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function render({
  form = false,
  creationRequest = 0,
  key = 'board',
  done = false,
}: { form?: boolean; creationRequest?: number; key?: string; done?: boolean } = {}) {
  act(() =>
    root.render(
      <MobileBoardSections
        key={key}
        sections={[
          {
            column: { id: 'ISSUES', label: 'Todo', description: '' },
            count: 0,
            visible: true,
            content: form ? <textarea autoFocus aria-label="Task" /> : <p>Issues</p>,
          },
          {
            column: { id: 'WORKING', label: 'Working', description: '' },
            count: 1,
            visible: true,
            content: <p>New task</p>,
          },
          ...(done
            ? [
                {
                  column: { id: 'DONE' as const, label: 'Done', description: '' },
                  count: 0,
                  visible: true,
                  content: <p>Completed tasks</p>,
                },
              ]
            : []),
        ]}
        showInlineForm={form}
        inlineFormRequest={form ? 1 : 0}
        workspaceCreationRequest={creationRequest}
      />
    )
  );
}

it('preserves the new composer focus when revealing Todo', () => {
  render();
  render({ form: true });
  const input = container.querySelector('textarea');
  expect(input).not.toBeNull();
  expect(document.activeElement).toBe(input);
});

it('reveals Working only for new creation requests, not mount or remount', () => {
  render({ creationRequest: 7 });
  const working = container.querySelector<HTMLElement>('section[aria-label="Working"]')!;
  expect(document.activeElement).not.toBe(working);

  const scroll = container.querySelector<HTMLElement>('[data-mobile-board]')!;
  const navigation = container.querySelector('nav')!;
  const scrollTo = vi.fn();
  Object.defineProperty(scroll, 'scrollTo', { value: scrollTo });
  Object.defineProperty(navigation, 'offsetHeight', { value: 40 });
  vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 390, 600));
  vi.spyOn(working, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 500, 390, 200));
  scroll.scrollTop = 200;

  render({ creationRequest: 8 });
  expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 548, behavior: 'instant' });
  expect(document.activeElement).toBe(working);

  render({ creationRequest: 8 });
  expect(scrollTo).toHaveBeenCalledTimes(1);

  render({ creationRequest: 8, key: 'remounted' });
  expect(document.activeElement).not.toBe(container.querySelector('section[aria-label="Working"]'));
});

it('marks the last section active when scrolling to the end before its heading reaches the top', async () => {
  render();
  const scroll = container.querySelector<HTMLElement>('[data-mobile-board]')!;
  const navigation = container.querySelector('nav')!;
  const working = container.querySelector<HTMLElement>('section[aria-label="Working"]')!;
  Object.defineProperties(scroll, {
    clientHeight: { value: 600 },
    scrollHeight: { value: 1000 },
  });
  Object.defineProperty(navigation, 'offsetHeight', { value: 40 });
  vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 390, 600));
  vi.spyOn(working, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 500, 390, 100));
  scroll.scrollTop = 400;
  await act(() => {
    scroll.dispatchEvent(new Event('scroll'));
  });
  expect(container.querySelector('a[aria-current="location"]')?.textContent).toBe('Working 1');

  scroll.scrollTop = 0;
  await act(() => {
    scroll.dispatchEvent(new Event('scroll'));
  });
  expect(container.querySelector('a[aria-current="location"]')?.textContent).toBe('Todo 0');
});

it('retains a clamped navigation selection until the scroll position changes', async () => {
  render({ done: true });
  const scroll = container.querySelector<HTMLElement>('[data-mobile-board]')!;
  Object.defineProperties(scroll, {
    clientHeight: { value: 600 },
    scrollHeight: { value: 1000 },
    scrollTo: {
      value: () => {
        scroll.scrollTop = 400;
      },
    },
  });
  const working = container.querySelector<HTMLElement>('section[aria-label="Working"]')!;
  vi.spyOn(working, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 500, 390, 100));
  await act(() => container.querySelectorAll('a')[1]!.click());
  await act(() => {
    scroll.dispatchEvent(new Event('scroll'));
  });
  expect(document.activeElement).toBe(working);
  expect(container.querySelector('a[aria-current="location"]')?.textContent).toBe('Working 1');

  scroll.scrollTop = 300;
  await act(() => {
    scroll.dispatchEvent(new Event('scroll'));
  });
  scroll.scrollTop = 400;
  await act(() => {
    scroll.dispatchEvent(new Event('scroll'));
  });
  expect(container.querySelector('a[aria-current="location"]')?.textContent).toBe('Done 0');
});

it('keeps a clamped navigation selection when content elsewhere shrinks the board', async () => {
  render({ done: true });
  const scroll = container.querySelector<HTMLElement>('[data-mobile-board]')!;
  let scrollHeight = 1000;
  Object.defineProperties(scroll, {
    clientHeight: { value: 600 },
    scrollHeight: { get: () => scrollHeight },
    scrollTo: {
      value: () => {
        scroll.scrollTop = 400;
      },
    },
  });
  const working = container.querySelector<HTMLElement>('section[aria-label="Working"]')!;
  vi.spyOn(working, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 500, 390, 100));
  await act(() => container.querySelectorAll('a')[1]!.click());

  // Issues arriving in Todo leave it 4px shorter, and the browser clamps the scroll.
  scrollHeight = 996;
  scroll.scrollTop = 396;
  await act(() => {
    scroll.dispatchEvent(new Event('scroll'));
  });
  expect(container.querySelector('a[aria-current="location"]')?.textContent).toBe('Working 1');
});

/**
 * A board whose Working section sits at `layout.working` below the top of the
 * scroll content, with Done two pixels after it, and whose scroll position the
 * test moves the way a browser does.
 */
function renderPositionedBoard(layout: { working: number }) {
  render({ done: true });
  const scroll = container.querySelector<HTMLElement>('[data-mobile-board]')!;
  Object.defineProperties(scroll, {
    clientHeight: { value: 600 },
    scrollHeight: { value: 2000 },
    scrollTo: {
      value: ({ top }: { top: number }) => {
        scroll.scrollTop = top;
      },
    },
  });
  Object.defineProperty(container.querySelector('nav')!, 'offsetHeight', { value: 40 });
  vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 390, 600));
  for (const [label, gap] of [
    ['Working', 0],
    ['Done', 2],
  ] as const) {
    const section = container.querySelector<HTMLElement>(`section[aria-label="${label}"]`)!;
    vi.spyOn(section, 'getBoundingClientRect').mockImplementation(
      () => new DOMRect(0, 100 + layout.working + gap - scroll.scrollTop, 390, 100)
    );
  }
  const scrolled = () =>
    act(() => {
      scroll.dispatchEvent(new Event('scroll'));
    });
  const active = () => container.querySelector('a[aria-current="location"]')?.textContent;
  return { scroll, scrolled, active };
}

it('keeps an unclamped navigation selection when content above it changes height', async () => {
  const layout = { working: 500 };
  const { scroll, scrolled, active } = renderPositionedBoard(layout);
  await act(() => container.querySelectorAll('a')[1]!.click());
  expect(scroll.scrollTop).toBe(448);

  // Cards arriving above Working push it down 50px, and the browser's scroll
  // anchoring moves the scroll with it, so Working stays where the jump put it.
  layout.working = 550;
  scroll.scrollTop = 498;
  await scrolled();
  expect(active()).toBe('Working 1');
});

it('drops an unclamped navigation selection once the board scrolls elsewhere', async () => {
  const layout = { working: 500 };
  const { scroll, scrolled, active } = renderPositionedBoard(layout);
  await act(() => container.querySelectorAll('a')[1]!.click());
  layout.working = 550;
  scroll.scrollTop = 498;
  await scrolled();
  expect(active()).toBe('Working 1');

  scroll.scrollTop = 300;
  await scrolled();
  expect(active()).toBe('Todo 0');
  // Back at the re-recorded position, the jump no longer holds the selection.
  scroll.scrollTop = 498;
  await scrolled();
  expect(active()).toBe('Done 0');
});
