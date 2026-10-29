// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { actFlushSync } from '@/test-utils/react-act';
import { MobileAgentsFixture } from './mobile-agents-fixture';

let container: HTMLDivElement;
let root: Root;
function button(name: string, scope: ParentNode = container) {
  const result = [...scope.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === name
  );
  if (!result) {
    throw new Error(`Missing button ${name}`);
  }
  return result;
}
function fill(selector: string, value: string) {
  const field = container.querySelector(selector);
  const prototype =
    selector === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  actFlushSync(() => {
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, value);
    field?.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  actFlushSync(() =>
    root.render(
      <MemoryRouter>
        <MobileAgentsFixture />
      </MemoryRouter>
    )
  );
});
afterEach(() => {
  actFlushSync(() => root.unmount());
  container.remove();
});
it('creates distinct fresh agents without inheriting the selected agent history or paused state', async () => {
  actFlushSync(() =>
    container.querySelector<HTMLAnchorElement>('a[href="/agents/dependencies"]')?.click()
  );
  const createdIds: string[] = [];
  for (const name of ['First new agent', 'Second new agent']) {
    actFlushSync(() => button('Create Agent').click());
    fill('input[name="name"]', name);
    fill('textarea', 'Review changes');
    await act(() =>
      container
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    );
    const link = container.querySelector('nav a[aria-current="page"]');
    createdIds.push(link?.getAttribute('href') ?? '');
    expect(container.querySelector('h2')?.textContent).toBe(name);
    expect(container.querySelector('main')?.textContent).toContain('Last run: No runs yet');
    expect(container.querySelector('main')?.textContent).toContain('Active');
    expect(container.querySelector('main')?.textContent).toContain(
      'No runs yet. Future runs will appear here.'
    );
    expect(container.querySelector('main a[href*="/workspaces/"]')).toBeNull();
  }
  expect(new Set(createdIds).size).toBe(2);
  const allLinks = [...container.querySelectorAll('nav a')].map((link) =>
    link.getAttribute('href')
  );
  expect(allLinks).toHaveLength(4);
  expect(new Set(allLinks).size).toBe(4);
});
it.each([
  { ctrlKey: true },
  { metaKey: true },
  { shiftKey: true },
  { altKey: true },
  { button: 1 },
])('preserves native fixture link behavior for modified clicks %j', (modifiers) => {
  let prevented = true;
  document.addEventListener(
    'click',
    (event) => {
      prevented = event.defaultPrevented;
      event.preventDefault();
    },
    { once: true }
  );
  actFlushSync(() =>
    container
      .querySelector<HTMLAnchorElement>('a[href="/agents/dependencies"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...modifiers }))
  );
  expect(prevented).toBe(false);
  expect(container.querySelector('h2')?.textContent).toBe('Review recent changes');
});
