// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FactoryConfig } from '@/shared/schemas/factory-config.schema';
import { ProjectFactoryConfigCard } from './ProjectFactoryConfigCard';

const mocks = vi.hoisted(() => ({
  query: {
    data: null as FactoryConfig | null | undefined,
    isPending: false,
    isSuccess: true,
    isError: false,
    error: null as Error | null,
  },
  saveMutate: vi.fn(),
  saveError: null as Error | null,
  onSaveError: undefined as ((error: Error) => void) | undefined,
  invalidate: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ workspace: { getFactoryConfig: { invalidate: mocks.invalidate } } }),
    workspace: {
      getFactoryConfig: { useQuery: () => mocks.query },
      refreshFactoryConfigs: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    },
    project: {
      saveFactoryConfig: {
        useMutation: (options: { onError?: (error: Error) => void }) => {
          mocks.onSaveError = options.onError;
          return { mutate: mocks.saveMutate, isPending: false, error: mocks.saveError };
        },
      },
    },
  },
}));

let root: Root;
let container: HTMLDivElement;
function renderCard() {
  flushSync(() =>
    root.render(
      createElement(ProjectFactoryConfigCard, { projectId: 'project-1', projectName: 'Alpha' })
    )
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.query = { data: null, isPending: false, isSuccess: true, isError: false, error: null };
  mocks.saveError = null;
  mocks.saveMutate.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  root.unmount();
  document.body.innerHTML = '';
});

describe('ProjectFactoryConfigCard', () => {
  it('gives the edit control an accessible name', () => {
    renderCard();
    expect(
      container.querySelector('button[aria-label="Edit factory configuration"]')
    ).not.toBeNull();
  });

  it('does not offer an empty editor while configuration is loading', () => {
    mocks.query = {
      data: undefined,
      isPending: true,
      isSuccess: false,
      isError: false,
      error: null,
    };
    renderCard();
    const edit = container.querySelector('button');
    expect(edit?.disabled).toBe(true);
    expect(container.textContent).toContain('Loading configuration');
    expect(container.textContent).not.toContain('Not configured');
    flushSync(() => edit?.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(mocks.saveMutate).not.toHaveBeenCalled();
  });

  it('does not offer an empty editor after the configuration query fails', () => {
    mocks.query = {
      data: undefined,
      isPending: false,
      isSuccess: false,
      isError: true,
      error: new Error('Repository unavailable'),
    };
    renderCard();
    expect(container.querySelector('button')?.disabled).toBe(true);
    expect(container.textContent).toContain('Repository unavailable');
    expect(container.textContent).not.toContain('Not configured');
  });

  it('loads existing scripts into the editor after the query succeeds', () => {
    mocks.query.data = { scripts: { run: 'pnpm dev', setup: 'pnpm install' } };
    renderCard();
    flushSync(() => container.querySelector('button')?.click());
    expect(document.querySelector<HTMLInputElement>('#run-command')?.value).toBe('pnpm dev');
    expect(document.querySelector<HTMLInputElement>('#setup-command')?.value).toBe('pnpm install');
  });

  it('closes the editor if a later query fails instead of saving stale scripts', () => {
    mocks.query.data = { scripts: { run: 'pnpm dev' } };
    renderCard();
    flushSync(() => container.querySelector('button')?.click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    mocks.query = {
      ...mocks.query,
      isSuccess: false,
      isError: true,
      error: new Error('Repository unavailable'),
    };
    renderCard();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(mocks.saveMutate).not.toHaveBeenCalled();
  });

  it('surfaces a failed save in a toast and keeps the editor open with its error', () => {
    mocks.saveMutate.mockImplementation(() => {
      mocks.saveError = new Error('Write permission denied');
      mocks.onSaveError?.(mocks.saveError);
    });
    renderCard();
    flushSync(() => container.querySelector('button')?.click());
    const save = Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Create Configuration')
    );
    expect(save).toBeDefined();
    flushSync(() => save?.click());
    expect(toast.error).toHaveBeenCalledWith(
      'Failed to save configuration: Write permission denied'
    );
    renderCard();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'Write permission denied'
    );
  });
});
