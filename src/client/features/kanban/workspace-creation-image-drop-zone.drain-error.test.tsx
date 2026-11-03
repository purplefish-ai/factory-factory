// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { waitForReact } from '@/test-utils/react-act';
import { getWorkspaceCreationDraftSnapshot } from './workspace-creation-draft-storage';
import { getPendingWorkspaceCreationDropProjectIds } from './workspace-creation-drop-queue';
import { WorkspaceCreationImageDropZone } from './workspace-creation-image-drop-zone';

const chunk = vi.hoisted(() => ({ fail: true }));
const toastError = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { error: toastError } }));
vi.mock('./workspace-creation-drop-drain', async (importOriginal) => {
  if (chunk.fail) {
    throw new Error('Failed to fetch drain chunk');
  }
  return await importOriginal();
});

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('reportError', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

function drop(target: Element, name: string) {
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      items: [{ kind: 'file', type: 'image/png' }],
      files: [new File(['image'], name, { type: 'image/png' })],
    },
  });
  return act(() => target.dispatchEvent(event));
}

it('reports a failed drain chunk and retries it on the next drop', async () => {
  const projectId = crypto.randomUUID();
  const container = document.createElement('div');
  document.body.append(container);
  const uncaught = vi.fn();
  const root = createRoot(container, { onCaughtError: () => undefined, onUncaughtError: uncaught });
  try {
    await act(() =>
      root.render(
        <WorkspaceCreationImageDropZone projectId={projectId} onDropAccepted={() => undefined}>
          <p>Sidebar</p>
        </WorkspaceCreationImageDropZone>
      )
    );
    const target = container.querySelector('p')!;

    await drop(target, 'lost.png');
    await waitForReact(() =>
      expect(toastError).toHaveBeenCalledExactlyOnceWith(
        'Dropped images could not be attached. Try dropping them again.'
      )
    );
    expect(getPendingWorkspaceCreationDropProjectIds()).not.toContain(projectId);
    expect(uncaught).not.toHaveBeenCalled();
    expect(globalThis.reportError).toHaveBeenCalledWith(
      // Vitest wraps the factory error; the boundary must add the component trace.
      expect.objectContaining({ stack: expect.stringContaining('DropDrainBoundary') })
    );
    expect(container.textContent).toBe('Sidebar');

    chunk.fail = false;
    await drop(target, 'retry.png');
    await waitForReact(() =>
      expect(
        getWorkspaceCreationDraftSnapshot(projectId).draft?.attachments.map(({ name }) => name)
      ).toEqual(['retry.png'])
    );
    expect(toastError).toHaveBeenCalledOnce();
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});
