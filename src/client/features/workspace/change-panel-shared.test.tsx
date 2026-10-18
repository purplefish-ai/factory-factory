// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ChangeListEntry, ChangeTreeView } from './change-panel-shared';

const mocks = vi.hoisted(() => ({
  listFilesUseQuery: vi.fn(() => ({
    data: {
      entries: [{ name: 'a.ts', path: 'myfolder/a.ts', type: 'file' as const }],
    },
    isError: false,
    isLoading: false,
  })),
}));

vi.mock('@phosphor-icons/react/dist/csr/CaretDown', () => ({ CaretDownIcon: () => null }));
vi.mock('@phosphor-icons/react/dist/csr/CaretRight', () => ({ CaretRightIcon: () => null }));
vi.mock('@phosphor-icons/react/dist/csr/FileCode', () => ({ FileCodeIcon: () => null }));
vi.mock('@phosphor-icons/react/dist/csr/FileDashed', () => ({ FileDashedIcon: () => null }));
vi.mock('@phosphor-icons/react/dist/csr/FileMinus', () => ({ FileMinusIcon: () => null }));
vi.mock('@phosphor-icons/react/dist/csr/FilePlus', () => ({ FilePlusIcon: () => null }));
vi.mock('@phosphor-icons/react/dist/csr/Folder', () => ({ FolderIcon: () => null }));
vi.mock('@phosphor-icons/react/dist/csr/SpinnerGap', () => ({ SpinnerGapIcon: () => null }));
vi.mock('@phosphor-icons/react/dist/csr/WarningCircle', () => ({ WarningCircleIcon: () => null }));

vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    workspace: {
      listFiles: {
        useQuery: mocks.listFilesUseQuery,
      },
    },
  },
}));

afterEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('ChangeTreeView', () => {
  it('uses inferred children instead of fetching contents for a git-reported directory', () => {
    const entries: ChangeListEntry[] = [
      { path: 'myfolder/', kind: 'untracked', statusCode: '?' },
      { path: 'myfolder/a.ts', kind: 'modified', statusCode: 'M' },
    ];
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(
        createElement(ChangeTreeView, {
          entries,
          onFileClick: vi.fn(),
          workspaceId: 'workspace-1',
        })
      );
    });

    expect(mocks.listFilesUseQuery).not.toHaveBeenCalled();
    expect(
      Array.from(container.querySelectorAll('button')).filter((button) =>
        button.textContent?.includes('a.ts')
      )
    ).toHaveLength(1);

    root.unmount();
  });
});
