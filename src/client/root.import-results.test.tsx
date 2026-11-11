// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root as ReactRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRecoveryImportReport } from '@/shared/recovery-import-report';
import { recoveryMetadataSchema } from '@/shared/schemas/recovery-envelope.schema';
import full from '@/shared/testing/recovery-base-json-v8.fixture.json';
import fixed from '@/shared/testing/recovery-base-json-workspace-v8.fixture.json';
import { DataImportButton } from './features/data-import/data-import-button';
import { Root } from './root';

const rpc = vi.hoisted(() => ({
  invalidate: vi.fn(),
  error: vi.fn(),
  mutate: vi.fn(),
  failure: null as Error | null,
}));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ invalidate: rpc.invalidate }),
    admin: {
      importData: {
        useMutation: (options: {
          onSuccess: (response: { results: typeof result }) => Promise<void>;
          onError: (error: Error) => void;
        }) => ({
          isPending: false,
          mutate: () => {
            rpc.mutate();
            if (rpc.failure) {
              options.onError(rpc.failure);
              return;
            }
            void options.onSuccess({ results: result }).catch(options.onError);
          },
        }),
      },
    },
  },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: rpc.error } }));
vi.mock('@/client/components/theme-provider', () => ({
  ThemeProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/client/components/appearance-provider', () => ({
  AppearanceProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/client/lib/providers', () => ({
  TRPCProvider: ({ children }: { children: ReactNode }) => children,
  useProjects: () => ({ projects: [{}] }),
}));
vi.mock('@/client/components/resizable-layout', () => ({
  AppLayout: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
vi.mock('@/client/components/factory-update-banner', () => ({ FactoryUpdateBanner: () => null }));
vi.mock('@/client/components/cli-health-banner', () => ({ CLIHealthBanner: () => null }));
vi.mock('@/client/components/model-catalog-warning', () => ({ ModelCatalogWarning: () => null }));
vi.mock('@/client/features/workspace/WorkspaceNotificationManager', () => ({
  WorkspaceNotificationManager: () => null,
}));
vi.mock('@/components/ui/sonner', () => ({ Toaster: () => null }));
vi.mock('@/hooks/use-visual-viewport-height', () => ({
  useVisualViewportHeight: () => ({ height: '800px', offsetTop: '0px' }),
}));
const download = vi.hoisted(() => vi.fn());
vi.mock('@/client/lib/download-file', () => ({ downloadFile: download }));
const result = {
  recovery: createRecoveryImportReport(recoveryMetadataSchema.parse(fixed.meta.recovery)),
  projects: { imported: 1, skipped: 2 },
  workspaces: { imported: 3, skipped: 4 },
  agentSessions: { imported: 5, skipped: 6 },
  terminalSessions: { imported: 7, skipped: 8 },
  userSettings: { imported: false, skipped: true },
  inertTransforms: {
    workspaceWorkflows: 19,
    workspaceInitializations: 9,
    workspaceArchives: 10,
    runScripts: 11,
    terminalSessions: 12,
    agentSessions: 13,
    monitors: 14,
    heldReceipts: 15,
    cancelledFacts: 16,
    explanations: ['Imported sessions remain stopped.'],
  },
};
function ImportRoute({ navigateAfter }: { navigateAfter: boolean }) {
  const navigate = useNavigate();
  return (
    <DataImportButton
      onImportSuccess={() => {
        if (navigateAfter) {
          void navigate('/done');
        }
      }}
    />
  );
}
let root: ReactRoot;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  vi.clearAllMocks();
  rpc.failure = null;
  rpc.invalidate.mockResolvedValue(undefined);
});
afterEach(async () => {
  await act(() => root.unmount());
  document.body.innerHTML = '';
});
async function mount(path = '/projects/new', navigateAfter = true) {
  await act(() =>
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<Root />}>
            <Route path="projects/new" element={<ImportRoute navigateAfter={navigateAfter} />} />
            <Route path="admin" element={<ImportRoute navigateAfter={navigateAfter} />} />
            <Route path="done" element={<p>Destination route</p>} />
          </Route>
        </Routes>
      </MemoryRouter>
    )
  );
}
async function importBackup(
  text = JSON.stringify({
    meta: { exportedAt: '2026-01-01T00:00:00.000Z', version: '1', schemaVersion: 7 },
    data: {
      projects: [],
      workspaces: [],
      agentSessions: [],
      terminalSessions: [],
      userSettings: null,
    },
  })
) {
  const file = new File([text], 'backup.json', { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: async () => text });
  const input = document.querySelector('input[type="file"]');
  if (!(input instanceof HTMLInputElement)) {
    throw new Error('Missing file input');
  }
  await act(async () => {
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
  });
}
async function click(label: string) {
  const button = [...document.querySelectorAll('button')].find(
    (item) => item.textContent === label
  );
  if (!button) {
    throw new Error(`Missing ${label}`);
  }
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
}
describe('Root import results', () => {
  it('requires confirmation and preserves the import failure flow without publishing success', async () => {
    await mount();
    await importBackup();
    expect(rpc.mutate).not.toHaveBeenCalled();
    await click('Cancel');
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(rpc.mutate).not.toHaveBeenCalled();
    rpc.failure = new Error('Backup could not be imported');
    await importBackup();
    await click('Import');
    expect(rpc.error).toHaveBeenCalledWith("Couldn't import backup. Backup could not be imported");
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.body.textContent).not.toContain('Destination route');
    expect(rpc.invalidate).not.toHaveBeenCalled();
  });
  it('retains and downloads the committed server result after callback navigation unmounts the button', async () => {
    await mount();
    await importBackup();
    await click('Import');
    expect(document.body.textContent).toContain('Destination route');
    expect(document.querySelector('input[type="file"]')).toBeNull();
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
      'Import completed'
    );
    await click('Download JSON');
    expect(JSON.parse(download.mock.calls[0]?.[0].data)).toEqual(result);
    expect(download.mock.calls[0]?.[0].fileName).toBe('factory-factory-import-result.json');
    await click('Dismiss');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.activeElement).toBe(document.getElementById('app-content'));
  });
  it('publishes before a stalled refresh and keeps the result after refresh rejects without import failure', async () => {
    let rejectRefresh: (reason: Error) => void = () => undefined;
    rpc.invalidate.mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectRefresh = reject;
        })
    );
    await mount();
    await importBackup();
    await click('Import');
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
      'Import completed'
    );
    expect(document.body.textContent).not.toContain('Destination route');
    await act(async () => rejectRefresh(new Error('Refresh unavailable')));
    expect(document.body.textContent).toContain('Destination route');
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
      'Import completed'
    );
    expect(rpc.error.mock.calls.flat().join(' ')).not.toContain('Import failed');
    expect(rpc.mutate).toHaveBeenCalledTimes(1);
  });
  it('keeps the results on the admin route through refresh and preserves file-validation errors', async () => {
    await mount('/admin', false);
    await importBackup();
    await click('Import');
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
      'Import completed'
    );
    await importBackup('{invalid');
    expect(rpc.error.mock.calls.flat().join(' ')).toContain("Couldn't read file");
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
      'Import completed'
    );
  });
});

it('retains the exact full-profile server report through Root navigation and download', async () => {
  const previous = result.recovery;
  result.recovery = createRecoveryImportReport(recoveryMetadataSchema.parse(full.meta.recovery));
  try {
    await mount();
    await importBackup();
    await click('Import');
    expect(document.body.textContent).toContain('Destination route');
    for (const warning of result.recovery.warnings) {
      expect(document.body.textContent).toContain(warning);
    }
    expect(document.body.textContent).toContain('actual included PR rows');
    await click('Download JSON');
    expect(JSON.parse(download.mock.calls[0]![0].data)).toEqual(result);
  } finally {
    result.recovery = previous;
  }
});
