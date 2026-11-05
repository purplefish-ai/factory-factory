// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { chooseAgentCreation } from '@/client/features/agents/agent-menu.test-support';
import { actFlushSync } from '@/test-utils/react-act';
import { MobileAgentsFixture } from './mobile-agents-fixture';

vi.mock('@/client/features/search', () => ({
  GlobalSearch: () => <button aria-label="Search">Search</button>,
}));
vi.mock('@/hooks/use-mobile', () => ({ MOBILE_BREAKPOINT: 768, useIsMobile: () => true }));
vi.mock('@/client/hooks/use-project-issues', () => ({ useProjectIssues: () => ({ issues: [] }) }));
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
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
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
  const dependenciesLink = container.querySelector<HTMLAnchorElement>(
    'a[href="/projects/factory-factory/agents/dependencies"]'
  );
  if (!dependenciesLink) {
    throw new Error('Missing Dependencies agent rail link');
  }
  actFlushSync(() => dependenciesLink.click());
  expect(container.querySelector('main h2')?.textContent).toBe('Keep dependencies current');
  expect(container.querySelector('main')?.textContent).toContain('Paused');
  const createdIds: string[] = [];
  for (const name of ['First new agent', 'Second new agent']) {
    await chooseAgentCreation(container);
    fill('input[name="name"]', name);
    fill('textarea', 'Review changes');
    await act(() =>
      container
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    );
    const link = container.querySelector('nav a[aria-current="page"]');
    createdIds.push(link?.getAttribute('href') ?? '');
    expect(container.querySelector('main h2')?.textContent).toBe(name);
    expect(container.querySelector('main')?.textContent).toContain('Last run: No runs yet');
    expect(container.querySelector('main')?.textContent).toContain('Active');
    expect(container.querySelector('main')?.textContent).toContain(
      'No runs yet. Future runs will appear here.'
    );
    expect(container.querySelector('main a[href*="/workspaces/"]')).toBeNull();
  }
  expect(new Set(createdIds).size).toBe(2);
  const allLinks = [...container.querySelectorAll('nav[aria-label="Agents"] a')].map((link) =>
    link.getAttribute('href')
  );
  expect(allLinks).toHaveLength(6);
  expect(new Set(allLinks).size).toBe(6);
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
      .querySelector<HTMLAnchorElement>('a[href="/projects/factory-factory/agents/dependencies"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...modifiers }))
  );
  expect(prevented).toBe(false);
  expect(container.querySelector('main h2')?.textContent).toBe('Review recent changes');
});

it('keeps the project selector in the navbar and section links in the real mobile sidebar', () => {
  expect(container.querySelector('button[aria-label^="Open project menu"]')).not.toBeNull();
  expect(container.querySelector('nav[aria-label="Project sections"]')).toBeNull();
  expect(container.querySelector('#agents-project-filter')).toBeNull();
  actFlushSync(() =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Toggle sidebar"]')?.click()
  );
  const footer = document.querySelector('[role="dialog"] [data-sidebar="footer"]');
  expect(
    [...(footer?.querySelectorAll('a') ?? [])].map((link) => link.getAttribute('href'))
  ).toEqual([
    '/projects/factory-factory/workspaces',
    '/projects/factory-factory/agents',
    '/projects/factory-factory/reviews',
    '/admin',
  ]);
  expect(footer?.textContent).toContain('Reviews2');
});

it('uses actual saved detail, editor and blank replacement with explicit fixture preview feedback', async () => {
  actFlushSync(() =>
    container
      .querySelector<HTMLAnchorElement>(
        'a[href="/projects/factory-factory/agents/event-agent?kind=event"]'
      )
      ?.click()
  );
  expect(container.querySelector('main h2')?.textContent).toBe('Investigate labeled issues');
  expect(container.querySelector('main')?.textContent).not.toContain('Run history');
  actFlushSync(() => button('Edit agent').click());
  expect(container.querySelector('textarea[aria-label="Instructions"]')).not.toBeNull();
  await act(() => button('Validate draft').click());
  expect(container.textContent).toContain(
    'Native discovery is unavailable in this frontend fixture.'
  );
  actFlushSync(() =>
    container
      .querySelector<HTMLAnchorElement>(
        'a[href="/projects/factory-factory/agents/replacement-agent?kind=event"]'
      )
      ?.click()
  );
  actFlushSync(() => button('Edit agent').click());
  expect(container.querySelector('form')).toBeNull();
  actFlushSync(() => button('Replace complete specification').click());
  expect(
    container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Full saved specification JSON"]'
    )?.value
  ).toBe('');
});
it('keeps explicit frontend-only Slack channel pages accessible in the saved editor', async () => {
  actFlushSync(() =>
    container
      .querySelector<HTMLAnchorElement>(
        'a[href="/projects/factory-factory/agents/event-agent?kind=event"]'
      )
      ?.click()
  );
  actFlushSync(() => button('Edit agent').click());
  const connection = container.querySelector<HTMLInputElement>('input[id$="-connection"]');
  actFlushSync(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
      connection,
      'fixture-slack'
    );
    connection?.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(() => button('Refresh project sources').click());
  await act(() => button('More Slack channels').click());
  await act(() => button('More Slack channels').click());
  const sources = container.querySelector('[aria-label="Project sources"]');
  expect(sources?.textContent).toContain('Fixture channel one');
  expect(sources?.textContent).toContain('Fixture channel two');
  expect(sources?.textContent).toContain('Fixture channel three');
});
