// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { downloadFile } from '@/client/lib/download-file';
import { DataImportButton } from './data-import-button';

const state = vi.hoisted(() => ({
  complete: undefined as ((result: unknown) => Promise<void>) | undefined,
  invalidate: vi.fn(() => Promise.resolve()),
  navigated: vi.fn(),
}));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ invalidate: state.invalidate }),
    admin: {
      importData: {
        useMutation: (options: { onSuccess(result: unknown): Promise<void> }) => {
          state.complete = options.onSuccess;
          return { mutate: vi.fn(), isPending: false };
        },
      },
    },
  },
}));
vi.mock('@/client/lib/download-file', () => ({ downloadFile: vi.fn() }));
vi.mock('sonner', () => ({ toast: { warning: vi.fn(), success: vi.fn(), error: vi.fn() } }));
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  document.body.innerHTML = '';
  vi.clearAllMocks();
});
function ImportRoute() {
  const navigate = useNavigate();
  const [hasProjects, setHasProjects] = useState(false);
  state.invalidate.mockImplementation(() => {
    setHasProjects(true);
    return Promise.resolve();
  });
  return hasProjects
    ? createElement('p', null, 'Existing projects hide the onboarding import button')
    : createElement(DataImportButton, {
        onImportSuccess: () => {
          state.navigated();
          void navigate('/projects');
        },
      });
}
async function renderRoute() {
  await act(() =>
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: ['/projects/new'] },
        createElement(
          Routes,
          null,
          createElement(Route, { path: '/projects/new', element: createElement(ImportRoute) }),
          createElement(Route, {
            path: '/projects',
            element: createElement('p', null, 'Projects destination'),
          })
        )
      )
    )
  );
}
function result(skipped: number) {
  return {
    results: {
      projects: { imported: 1, skipped: 0 },
      workspaces: { imported: 0, skipped: 0 },
      agentSessions: { imported: 0, skipped: 0 },
      terminalSessions: { imported: 0, skipped: 0 },
      userSettings: { imported: false, skipped: false },
      recovery: {
        models: skipped ? [{ model: 'ClosedSession', imported: 0, skipped }] : [],
        skipped: Array.from({ length: skipped }, (_, index) => ({
          model: 'ClosedSession',
          identity: `archive-${index}`,
          reason: 'EXISTING_IDENTITY',
        })),
      },
    },
  };
}
function click(label: string) {
  const button = Array.from(document.querySelectorAll('button')).find(
    (node) => node.textContent === label
  );
  if (!button) {
    throw new Error(`Missing button: ${label}`);
  }
  button.click();
}

it('keeps skipped identities and downloadable report mounted before the projects/new success navigation', async () => {
  await renderRoute();
  await act(async () => {
    await state.complete?.(result(1));
  });
  expect(state.navigated).not.toHaveBeenCalled();
  expect(state.invalidate).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
  expect(document.body.textContent).toContain('archive-0');
  expect(document.body.textContent).toContain('1 retained record was skipped.');
  await act(() => click('Download full report'));
  expect(downloadFile).toHaveBeenCalledWith(
    expect.objectContaining({
      fileName: 'recovery-import-report.json',
      data: expect.stringContaining('archive-0'),
    })
  );
  await act(() => click('Close'));
  expect(state.invalidate).toHaveBeenCalledOnce();
  expect(state.navigated).toHaveBeenCalledOnce();
  expect(document.body.textContent).toContain('Projects destination');
});
it('retains plural wording and defers navigation for more than one skipped identity', async () => {
  await renderRoute();
  await act(async () => {
    await state.complete?.(result(2));
  });
  expect(state.navigated).not.toHaveBeenCalled();
  expect(state.invalidate).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain('2 retained records were skipped.');
});
it('keeps the immediate success navigation when there is no durable report to display', async () => {
  await renderRoute();
  await act(async () => {
    await state.complete?.(result(0));
  });
  expect(state.navigated).toHaveBeenCalledOnce();
  expect(document.body.textContent).toContain('Projects destination');
});

it('labels PR-prefixed history kinds without merging their acronym and next word', async () => {
  await renderRoute();
  const imported = result(1);
  imported.results.recovery.models = [
    { model: 'WorkspacePRMonitoring', imported: 0, skipped: 1 },
    { model: 'WorkspacePRDedicatedSession', imported: 0, skipped: 1 },
  ];
  await act(async () => {
    await state.complete?.(imported);
  });
  expect(document.body.textContent).toContain('Workspace PR Monitoring');
  expect(document.body.textContent).toContain('Workspace PR Dedicated Session');
});
