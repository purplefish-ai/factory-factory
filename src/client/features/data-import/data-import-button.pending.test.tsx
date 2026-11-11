// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DataImportButton } from './data-import-button';

const importState = vi.hoisted(() => ({ isPending: false }));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ invalidate: vi.fn() }),
    admin: {
      importData: {
        useMutation: () => ({ mutate: vi.fn(), isPending: importState.isPending }),
      },
    },
  },
}));
vi.mock('./data-import-results', () => ({
  useDataImportResults: () => ({ publishImportResult: vi.fn() }),
}));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  importState.isPending = false;
});

it('shows the import in flight on the button', async () => {
  await act(() => root.render(<DataImportButton />));
  const button = container.querySelector('button');
  expect(button?.textContent).toBe('Import data');
  expect(button?.disabled).toBe(false);

  importState.isPending = true;
  await act(() => root.render(<DataImportButton />));
  expect(button?.textContent).toBe('Importing…');
  expect(button?.disabled).toBe(true);
  expect(button?.getAttribute('aria-busy')).toBe('true');
  expect(button?.querySelector('[data-slot=spinner]')).not.toBeNull();
});
