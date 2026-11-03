// @vitest-environment jsdom
import { act, memo } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { KanbanFamilyProvider, useKanbanFamilyHighlight } from './kanban-family-highlight';

const parent = { id: 'parent', parentWorkspace: null, childWorkspaceCount: 2 };
const child = { id: 'child', parentWorkspace: { id: 'parent' }, childWorkspaceCount: 0 };
const sibling = { id: 'sibling', parentWorkspace: { id: 'parent' }, childWorkspaceCount: 0 };
const unrelated = { id: 'other', parentWorkspace: null, childWorkspaceCount: 0 };
const rows = [parent, child, sibling, unrelated];
function Card({ workspace }: { workspace: (typeof rows)[number] }) {
  const { highlighted, ...events } = useKanbanFamilyHighlight(workspace);
  return (
    <div {...events} data-id={workspace.id} data-highlighted={highlighted}>
      <a href={`#${workspace.id}`}>{workspace.id}</a>
      <button type="button">Menu</button>
    </div>
  );
}
const MemoConsumer = memo(function MemoConsumer({ onRender }: { onRender: () => void }) {
  onRender();
  const { highlighted } = useKanbanFamilyHighlight(child);
  return <span>{String(highlighted)}</span>;
});
// jsdom does not model browser :focus-visible modality. Send the keyboard event
// that the card handles; the Storybook browser check also exercises native Tab.
function keyboardFocus(element: HTMLElement) {
  element.focus();
  element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
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
  await act(() =>
    keyboardFocus(container.querySelector<HTMLAnchorElement>('[data-id="parent"] a')!)
  );
  expect(container.querySelectorAll('[data-highlighted="true"]')).toHaveLength(3);
  await act(() =>
    keyboardFocus(container.querySelector<HTMLButtonElement>('[data-id="parent"] button')!)
  );
  expect(container.querySelectorAll('[data-highlighted="true"]')).toHaveLength(3);
  await act(() =>
    keyboardFocus(container.querySelector<HTMLAnchorElement>('[data-id="other"] a')!)
  );
  expect(container.querySelector('[data-highlighted="true"]')).toBeNull();
  await act(() =>
    keyboardFocus(container.querySelector<HTMLAnchorElement>('[data-id="child"] a')!)
  );
  await act(() => root.render(render([unrelated])));
  expect(container.querySelector('[data-highlighted="true"]')).toBeNull();
  await act(() => root.render(render()));
  expect(container.querySelector('[data-highlighted="true"]')).toBeNull();
});

it('preserves memoized cards when the board rerenders without a family change', async () => {
  let renders = 0;
  const countRender = () => {
    renders += 1;
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const render = (label: string) => (
    <KanbanFamilyProvider workspaces={rows}>
      <MemoConsumer onRender={countRender} />
      <span>{label}</span>
    </KanbanFamilyProvider>
  );
  await act(() => root.render(render('before')));
  await act(() => root.render(render('after')));
  expect(container.textContent).toBe('falseafter');
  expect(renders).toBe(1);
});

it('clears pointer focus on leave but retains highlighting for keyboard interaction', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(() =>
    root.render(
      <KanbanFamilyProvider workspaces={rows}>
        {rows.map((workspace) => (
          <Card key={workspace.id} workspace={workspace} />
        ))}
      </KanbanFamilyProvider>
    )
  );
  const card = container.querySelector('[data-id="child"]')!;
  const button = card.querySelector<HTMLButtonElement>('button')!;
  await act(() => {
    card.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    button.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    button.focus();
    card.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
  });
  expect(container.querySelector('[data-highlighted="true"]')).toBeNull();
  await act(() =>
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  );
  expect(container.querySelectorAll('[data-highlighted="true"]')).toHaveLength(3);
});

it('clears only the unmounted card even when its workspace still exists in another column', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const render = (hiddenId?: string) => (
    <KanbanFamilyProvider workspaces={rows}>
      {rows
        .filter((workspace) => workspace.id !== hiddenId)
        .map((workspace) => (
          <Card key={workspace.id} workspace={workspace} />
        ))}
    </KanbanFamilyProvider>
  );
  await act(() => root.render(render()));
  await act(() =>
    container
      .querySelector('[data-id="child"]')!
      .dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  );
  await act(() => root.render(render('other')));
  expect(container.querySelectorAll('[data-highlighted="true"]')).toHaveLength(3);
  await act(() => root.render(render('child')));
  expect(container.querySelector('[data-highlighted="true"]')).toBeNull();
  await act(() => root.render(render()));
  await act(() =>
    keyboardFocus(container.querySelector<HTMLAnchorElement>('[data-id="child"] a')!)
  );
  expect(container.querySelectorAll('[data-highlighted="true"]')).toHaveLength(3);
  await act(() => root.render(render('child')));
  expect(container.querySelector('[data-highlighted="true"]')).toBeNull();
});

type Row = (typeof rows)[number] & { name?: string };
const CountedCard = memo(function CountedCard({
  workspace,
  onRender,
}: {
  workspace: Row;
  onRender: (id: string) => void;
}) {
  onRender(workspace.id);
  const { highlighted, ...events } = useKanbanFamilyHighlight(workspace);
  return <div {...events} data-id={workspace.id} data-highlighted={highlighted} />;
});

it('rerenders only the cards affected by a workspace update or a family hover', async () => {
  const renders: string[] = [];
  const countRender = (id: string) => renders.push(id);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const render = (workspaces: Row[]) => (
    <KanbanFamilyProvider workspaces={workspaces}>
      {workspaces.map((workspace) => (
        <CountedCard key={workspace.id} workspace={workspace} onRender={countRender} />
      ))}
    </KanbanFamilyProvider>
  );
  await act(() => root.render(render(rows)));
  renders.length = 0;

  // A snapshot patch yields a new list where only the changed row is replaced.
  const updated = rows.map((row) => (row.id === 'other' ? { ...row, name: 'renamed' } : row));
  await act(() => root.render(render(updated)));
  expect(renders).toEqual(['other']);

  renders.length = 0;
  const hovered = container.querySelector('[data-id="child"]')!;
  await act(() => hovered.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
  expect(
    [...container.querySelectorAll('[data-highlighted="true"]')].map((node) =>
      node.getAttribute('data-id')
    )
  ).toEqual(['parent', 'child', 'sibling']);
  expect(renders.sort()).toEqual(['child', 'parent', 'sibling']);

  renders.length = 0;
  await act(() => root.render(render(updated.map((row) => ({ ...row })))));
  expect(container.querySelectorAll('[data-highlighted="true"]')).toHaveLength(3);
  renders.length = 0;
  await act(() =>
    hovered.dispatchEvent(
      new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })
    )
  );
  expect(container.querySelector('[data-highlighted="true"]')).toBeNull();
  expect(renders.sort()).toEqual(['child', 'parent', 'sibling']);
});
