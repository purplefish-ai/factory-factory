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
}: { form?: boolean; creationRequest?: number; key?: string } = {}) {
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
