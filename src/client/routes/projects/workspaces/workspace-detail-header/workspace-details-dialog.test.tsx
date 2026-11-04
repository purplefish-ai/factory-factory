// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { WorkspaceDetailsDialog } from './workspace-details-dialog';
it('treats whitespace details as absent', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(() =>
      root.render(
        <WorkspaceDetailsDialog
          open
          onOpenChange={vi.fn()}
          workspace={{ description: '  ', initialPrompt: '\n\t' }}
        />
      )
    );
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('No description or initial prompt was provided');
    expect(dialog.textContent).not.toContain('Initial prompt');
  } finally {
    await act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
