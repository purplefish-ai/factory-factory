// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { KanbanImageDropZone } from './kanban-image-drop-zone';
import { useWorkspaceCreationDraft } from './use-workspace-creation-draft';

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => vi.unstubAllGlobals());

const openForm = vi.hoisted(() => vi.fn());
vi.mock('./kanban-context', () => ({
  useKanban: () => ({ projectId: 'image-drop-project', setShowInlineForm: openForm }),
}));

function DraftPreview() {
  const { draft, updateDraft, discardDraft } = useWorkspaceCreationDraft('image-drop-project');
  return (
    <>
      <button type="button" onClick={() => updateDraft({ prompt: 'Existing task instructions' })}>
        Save prompt
      </button>
      <button
        type="button"
        onClick={() => {
          void discardDraft();
        }}
      >
        Discard draft
      </button>
      <p>{draft.prompt}</p>
      {draft.attachments.map((attachment) => (
        <span key={attachment.id}>{attachment.name}</span>
      ))}
    </>
  );
}

it('opens creation and appends dropped images to the project draft without replacing instructions', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(() =>
      root.render(
        <KanbanImageDropZone>
          <DraftPreview />
        </KanbanImageDropZone>
      )
    );
    await act(() => container.querySelector('button')!.click());
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', {
      value: {
        items: [{ kind: 'file', type: 'image/png' }],
        files: [new File(['image'], 'reference.png', { type: 'image/png' })],
      },
    });
    await act(() => container.firstElementChild!.dispatchEvent(drop));
    expect(openForm).toHaveBeenCalledExactlyOnceWith(true);
    await vi.waitFor(() => expect(container.textContent).toContain('reference.png'));
    expect(container.textContent).toContain('Existing task instructions');
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});

it('does not resurrect a discarded draft when an image finishes reading', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let finishRead: (() => void) | undefined;
  vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(function (this: FileReader) {
    finishRead = () => {
      Object.defineProperty(this, 'result', { value: 'data:image/png;base64,aW1hZ2U=' });
      this.dispatchEvent(new ProgressEvent('load'));
    };
  });
  try {
    await act(() =>
      root.render(
        <KanbanImageDropZone>
          <DraftPreview />
        </KanbanImageDropZone>
      )
    );
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', {
      value: {
        items: [{ kind: 'file', type: 'image/png' }],
        files: [new File(['image'], 'late.png', { type: 'image/png' })],
      },
    });
    await act(() => container.firstElementChild!.dispatchEvent(drop));
    await act(() => container.querySelectorAll('button')[1]!.click());
    await act(async () => finishRead?.());
    expect(container.textContent).not.toContain('late.png');
  } finally {
    await act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  }
});
