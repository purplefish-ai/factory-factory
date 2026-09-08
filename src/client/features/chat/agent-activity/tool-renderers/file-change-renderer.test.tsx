// @vitest-environment jsdom

import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import type { CodexFileChangeEntry } from './file-change-parser';
import { CodexFileChangeRenderer } from './file-change-renderer';

it('keeps an expanded diff attached to its file when another change is inserted', () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const change: CodexFileChangeEntry = { path: 'src/a.ts', kind: 'update', diff: '+original' };
  const render = (changes: CodexFileChangeEntry[]) => {
    flushSync(() => root.render(<CodexFileChangeRenderer payload={{ changes }} />));
  };

  try {
    render([change]);
    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    if (!details) {
      throw new Error('Expected a diff preview');
    }
    details.open = true;

    render([
      { path: 'src/b.ts', kind: 'create', diff: '+new' },
      { ...change, diff: '+updated' },
    ]);

    const previews = container.querySelectorAll('details');
    expect(previews[0]?.open).toBe(false);
    expect(previews[1]).toBe(details);
    expect(previews[1]?.open).toBe(true);
    expect(previews[1]?.textContent).toContain('+updated');
  } finally {
    root.unmount();
  }
});
