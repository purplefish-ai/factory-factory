// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { KanbanFamilyProvider, useKanbanFamilyHighlight } from './kanban-family-highlight';

const parent = { id: 'parent', parentWorkspace: null, childWorkspaceCount: 2 };
const child = { id: 'child', parentWorkspace: { id: 'parent' }, childWorkspaceCount: 0 };
const sibling = { id: 'sibling', parentWorkspace: { id: 'parent' }, childWorkspaceCount: 0 };
const unrelated = { id: 'other', parentWorkspace: null, childWorkspaceCount: 0 };
const rows = [parent, child, sibling, unrelated];
function Card({ workspace }: { workspace: (typeof rows)[number] }) {
  const { highlighted, ...events } = useKanbanFamilyHighlight(workspace.id);
  return (
    <div {...events} data-id={workspace.id} data-highlighted={highlighted}>
      <a href={`#${workspace.id}`}>{workspace.id}</a>
      <button type="button">Menu</button>
    </div>
  );
}
const roots: ReturnType<typeof createRoot>[] = [];
beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(() => root.unmount());
  }
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

it('highlights one family across columns on hover and clears it on leave', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(() =>
    root.render(
      <KanbanFamilyProvider workspaces={rows}>
        {rows.map((workspace, i) => (
          <section key={workspace.id} aria-label={['Waiting', 'Working', 'Done', 'Waiting'][i]}>
            <Card workspace={workspace} />
          </section>
        ))}
      </KanbanFamilyProvider>
    )
  );
  const hovered = container.querySelector('[data-id="child"]')!;
  await act(() => hovered.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
  expect(
    [...container.querySelectorAll('[data-highlighted="true"]')].map((node) =>
      node.getAttribute('data-id')
    )
  ).toEqual(['parent', 'child', 'sibling']);
  await act(() =>
    hovered.dispatchEvent(
      new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })
    )
  );
  expect(container.querySelector('[data-highlighted="true"]')).toBeNull();
});

it('keeps keyboard highlighting within a card and clears removed family members', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const render = (workspaces = rows) => (
    <KanbanFamilyProvider workspaces={workspaces}>
      {workspaces.map((workspace) => (
        <Card key={workspace.id} workspace={workspace} />
      ))}
    </KanbanFamilyProvider>
  );
  await act(() => root.render(render()));
  await act(() => container.querySelector<HTMLAnchorElement>('[data-id="parent"] a')!.focus());
  expect(container.querySelectorAll('[data-highlighted="true"]')).toHaveLength(3);
  await act(() => container.querySelector<HTMLButtonElement>('[data-id="parent"] button')!.focus());
  expect(container.querySelectorAll('[data-highlighted="true"]')).toHaveLength(3);
  await act(() => container.querySelector<HTMLAnchorElement>('[data-id="other"] a')!.focus());
  expect(container.querySelector('[data-highlighted="true"]')).toBeNull();
  await act(() => container.querySelector<HTMLAnchorElement>('[data-id="child"] a')!.focus());
  await act(() => root.render(render([unrelated])));
  expect(container.querySelector('[data-highlighted="true"]')).toBeNull();
  await act(() => root.render(render()));
  expect(container.querySelector('[data-highlighted="true"]')).toBeNull();
});
