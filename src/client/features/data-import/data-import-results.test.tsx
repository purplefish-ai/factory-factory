// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DataImportResultsProvider, useDataImportResults } from './data-import-results';

const download = vi.hoisted(() => vi.fn());
vi.mock('@/client/lib/download-file', () => ({ downloadFile: download }));
const result = {
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
let publish: ReturnType<typeof useDataImportResults>['publishImportResult'];
function Publisher() {
  publish = useDataImportResults().publishImportResult;
  return <button>Unrelated control</button>;
}
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  vi.clearAllMocks();
});
afterEach(async () => {
  vi.useRealTimers();
  await act(() => root.unmount());
  document.body.innerHTML = '';
});
async function mount(onDismiss = vi.fn()) {
  await act(() =>
    root.render(
      <DataImportResultsProvider onDismiss={onDismiss}>
        <Publisher />
      </DataImportResultsProvider>
    )
  );
  await act(() => publish(result));
  return onDismiss;
}
async function click(label: string) {
  const button = [...document.querySelectorAll('button')].find(
    (item) => item.textContent === label
  );
  if (!button) {
    throw new Error(`Missing ${label}`);
  }
  await act(async () => button.click());
}
it('renders every actual counter and explanation with accessible title, description and bounded scrolling', async () => {
  await mount();
  const dialog = document.querySelector('[role="alertdialog"]');
  expect(dialog).not.toBeNull();
  expect(document.getElementById(dialog?.getAttribute('aria-labelledby') ?? '')?.textContent).toBe(
    'Import completed'
  );
  expect(
    document.getElementById(dialog?.getAttribute('aria-describedby') ?? '')?.textContent
  ).toContain('Actual imported and skipped records');
  for (const text of [
    'Projects: 1 imported, 2 skipped',
    'Workspaces: 3 imported, 4 skipped',
    'Agent sessions: 5 imported, 6 skipped',
    'Terminal sessions: 7 imported, 8 skipped',
    'User settings: skipped',
    '19 workspace workflows',
    '9 initializations',
    '10 archives',
    '11 run scripts',
    '12 terminals',
    '13 agent sessions',
    '14 monitors',
    '15 receipts',
    '16 pending facts',
    'Imported sessions remain stopped.',
    'Embedded row totals and account remapping totals: not reported.',
  ]) {
    expect(dialog?.textContent).toContain(text);
  }
  expect(dialog?.querySelector('.overflow-y-auto')).not.toBeNull();
});
it('downloads only the exact held result and keeps it open through rerenders, elapsed time and Escape', async () => {
  await mount();
  await click('Download JSON');
  expect(download).toHaveBeenCalledWith({
    data: JSON.stringify(result, null, 2),
    mimeType: 'application/json',
    fileName: 'factory-factory-import-result.json',
  });
  expect(JSON.parse(download.mock.calls[0]?.[0].data)).toEqual(result);
  vi.useFakeTimers();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  vi.useRealTimers();
  await act(() =>
    root.render(
      <DataImportResultsProvider>
        <Publisher />
        <p>Refreshed route</p>
      </DataImportResultsProvider>
    )
  );
  await act(() =>
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    )
  );
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
    'Projects: 1 imported, 2 skipped'
  );
  await click('Download JSON');
  expect(download).toHaveBeenCalledTimes(2);
});
it('queues concurrent completions and restores focus only after explicit final dismissal', async () => {
  const dismissed = await mount();
  await act(() => publish({ ...result, projects: { imported: 99, skipped: 0 } }));
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
    'Projects: 1 imported'
  );
  await click('Dismiss');
  expect(dismissed).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
    'Projects: 99 imported'
  );
  await click('Download JSON');
  expect(JSON.parse(download.mock.calls[0]?.[0].data).projects).toEqual({
    imported: 99,
    skipped: 0,
  });
  await click('Dismiss');
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(dismissed).toHaveBeenCalledOnce();
});
it('keeps keyboard focus in the dialog and renders long explanations without truncating the result', async () => {
  await mount();
  const outside = [...document.querySelectorAll('button')].find(
    (button) => button.textContent === 'Unrelated control'
  );
  await act(() => outside?.focus());
  expect(document.querySelector('[role="alertdialog"]')?.contains(document.activeElement)).toBe(
    true
  );
  await click('Dismiss');
  const explanations = Array.from(
    { length: 60 },
    (_, index) => `Recovery explanation ${index + 1}: review this imported workspace.`
  );
  await act(() =>
    publish({ ...result, inertTransforms: { ...result.inertTransforms, explanations } })
  );
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
    'Recovery explanation 60:'
  );
  await click('Download JSON');
  expect(JSON.parse(download.mock.calls[0]?.[0].data).inertTransforms.explanations).toEqual(
    explanations
  );
});
it.each([
  [{ imported: true, skipped: false }, 'User settings: imported'],
  [{ imported: false, skipped: false }, 'User settings: none'],
])('shows the server settings outcome %j', async (userSettings, label) => {
  await act(() =>
    root.render(
      <DataImportResultsProvider>
        <Publisher />
      </DataImportResultsProvider>
    )
  );
  await act(() => publish({ ...result, userSettings }));
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(label);
});
