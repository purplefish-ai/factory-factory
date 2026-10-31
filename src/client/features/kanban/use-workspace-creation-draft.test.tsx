// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { useWorkspaceCreationDraft } from './use-workspace-creation-draft';

const roots: Root[] = [];
afterEach(() => {
  roots.splice(0).forEach((root) => act(() => root.unmount()));
});
function Harness({
  id,
  onResult,
}: {
  id: string;
  onResult: (result: ReturnType<typeof useWorkspaceCreationDraft>) => void;
}) {
  const result = useWorkspaceCreationDraft(id);
  onResult(result);
  return createElement('p', { role: 'alert' }, result.persistenceError);
}
function mount(projectId: string) {
  const root = createRoot(document.createElement('div'));
  roots.push(root);
  let current: ReturnType<typeof useWorkspaceCreationDraft>;
  const render = async (id: string) => {
    await act(() => {
      root.render(
        createElement(Harness, {
          id,
          onResult: (result) => {
            current = result;
          },
        })
      );
    });
  };
  return {
    root,
    render,
    async start() {
      await render(projectId);
    },
    get current() {
      return current;
    },
  };
}
it('restores immediately after an edit and remount despite unavailable storage', async () => {
  const first = mount('remount');
  await first.start();
  act(() =>
    first.current.updateDraft({
      prompt: 'Preserve instructions',
      attachments: [{ id: 'a', name: 'a.txt', type: 'text/plain', size: 1, data: 'x' }],
    })
  );
  act(() => first.root.unmount());
  roots.splice(roots.indexOf(first.root), 1);
  const second = mount('remount');
  await second.start();
  expect(second.current.draft.prompt).toBe('Preserve instructions');
  expect(second.current.draft.attachments[0]?.data).toBe('x');
  expect(second.current.persistenceError).toContain('saved');
});
it('keeps async edits with their original project and clears only a captured revision', async () => {
  const mounted = mount('origin');
  await mounted.start();
  const oldUpdate = mounted.current.updateDraft;
  act(() => oldUpdate({ prompt: 'Original' }));
  const captured = mounted.current.captureDraft();
  act(() => mounted.current.updateDraft({ prompt: 'Newer' }));
  await act(async () => {
    await mounted.current.clearSubmittedDraft(captured.revision).catch(() => undefined);
  });
  expect(mounted.current.draft.prompt).toBe('Newer');
  await mounted.render('destination');
  act(() =>
    oldUpdate((draft) => ({
      attachments: [
        ...draft.attachments,
        { id: 'late', name: 'late.txt', type: 'text/plain', size: 1, data: 'late' },
      ],
    }))
  );
  expect(mounted.current.draft.attachments).toEqual([]);
  await mounted.render('origin');
  expect(mounted.current.draft.prompt).toBe('Newer');
  expect(mounted.current.draft.attachments[0]?.id).toBe('late');
});
it('discards the current draft explicitly while preserving a newer revision', async () => {
  const mounted = mount('discard');
  await mounted.start();
  act(() => mounted.current.updateDraft({ prompt: 'Discard' }));
  const revision = mounted.current.captureDraft().revision;
  await act(async () => {
    await mounted.current.clearSubmittedDraft(revision).catch(() => undefined);
  });
  expect(mounted.current.draft.prompt).toBe('');
  expect(mounted.current.hasDraft).toBe(false);
});

it.each([false, true])(
  'ignores attachment completion from a discarded lifecycle (replacement=%s)',
  async (replacement) => {
    const mounted = mount(`discard-attachment-${replacement}`);
    await mounted.start();
    act(() => mounted.current.updateDraft({ prompt: 'Discard this' }));
    const finishAttachment = mounted.current.updateDraft;
    const revision = mounted.current.captureDraft().revision;
    await act(async () => {
      await mounted.current.clearSubmittedDraft(revision).catch(() => undefined);
    });
    if (replacement) {
      act(() => mounted.current.updateDraft({ prompt: 'Replacement draft' }));
    }
    act(() =>
      finishAttachment((draft) => ({
        attachments: [
          ...draft.attachments,
          { id: 'late', name: 'late.txt', type: 'text/plain', size: 1, data: 'late' },
        ],
      }))
    );
    expect(mounted.current.draft.attachments).toEqual([]);
    expect(mounted.current.draft.prompt).toBe(replacement ? 'Replacement draft' : '');
    expect(mounted.current.hasDraft).toBe(replacement);
  }
);
