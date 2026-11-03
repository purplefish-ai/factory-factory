// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createRecoveryImportReport } from '@/shared/recovery-import-report';
import { recoveryMetadataSchema } from '@/shared/schemas/recovery-envelope.schema';
import definitions from '@/shared/testing/recovery-automation-definitions-v8.fixture.json';
import full from '@/shared/testing/recovery-base-json-v8.fixture.json';
import fixed from '@/shared/testing/recovery-base-json-workspace-v8.fixture.json';
import periodic from '@/shared/testing/recovery-periodic-config-v8.fixture.json';
import history from '@/shared/testing/recovery-periodic-history-v8.fixture.json';
import links from '@/shared/testing/recovery-periodic-links-v8.fixture.json';
import { DataImportResultsProvider, useDataImportResults } from './data-import-results';

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

it('discloses the exact partial manifest with an expandable model list and exclusions', async () => {
  await mount();
  expect(document.body.textContent).toContain('Partial backup coverage');
  for (const warning of result.recovery.warnings) {
    expect(document.body.textContent).toContain(warning);
  }
  expect(document.body.textContent).toContain(
    'Workspace.creationMetadata preserves SQL NULL versus top-level JSON null'
  );
  for (const label of [
    'secrets and encryption keys',
    'native account homes',
    'worktree and repository contents',
    'provider owned history',
    'live process ids and runtime leases',
    'physical nullable json fidelity',
  ]) {
    expect(document.body.textContent).toContain(label);
  }
  expect(document.body.textContent).not.toContain('PHYSICAL_NULLABLE_JSON_FIDELITY');
  const details = document.querySelector('details');
  expect(details?.querySelector('summary')?.textContent).toContain('37 model classifications');
  expect(details?.querySelectorAll('li')).toHaveLength(37);
  expect(details?.textContent).toContain('WorkspaceMailState: EXCLUDED');
  await click('Download JSON');
  expect(JSON.parse(download.mock.calls[0]![0].data)).toEqual(result);
  expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
});
it('shows legacy uncertainty without inventing model coverage', async () => {
  await mount();
  await click('Dismiss');
  await act(() => publish({ ...result, recovery: createRecoveryImportReport(undefined) }));
  expect(document.body.textContent).toContain('no versioned coverage declaration');
  expect(document.querySelector('details')).toBeNull();
});

it('renders and downloads the exact full catalog report without a physical-fidelity exclusion', async () => {
  await mount();
  await click('Dismiss');
  const fullResult = {
    ...result,
    recovery: createRecoveryImportReport(recoveryMetadataSchema.parse(full.meta.recovery)),
  };
  await act(() => publish(fullResult));
  for (const warning of fullResult.recovery.warnings) {
    expect(document.body.textContent).toContain(warning);
  }
  for (const model of ['Workspace', 'WorkspacePR', 'AgentSession']) {
    expect(document.body.textContent).toContain(
      full.meta.recovery.coverage.find((entry) => entry.model === model)!.limitation
    );
  }
  expect(document.body.textContent).not.toContain('physical nullable json fidelity');
  await click('Download JSON');
  expect(JSON.parse(download.mock.calls[0]![0].data)).toEqual(fullResult);
});

it('renders exact periodic counters with entire-source enabled scope and downloads the typed outcome', async () => {
  await mount();
  await click('Dismiss');
  const periodicResult = {
    ...result,
    recovery: createRecoveryImportReport(recoveryMetadataSchema.parse(periodic.meta.recovery), {
      model: 'PeriodicTask',
      imported: 2,
      skipped: 3,
      sourceEnabled: 4,
      restoredDisabled: 2,
      reasons: { EXISTING_IDENTITY: 1, INCOMPLETE_DEPENDENCY: 2 },
    }),
  };
  await act(() => publish(periodicResult));
  for (const text of [
    'Periodic configurations: 2 imported, 3 skipped',
    'Enabled in entire source section: 4; restored disabled: 2',
    'Skips by reason: existing task ID: 1; project not created by this import: 2.',
  ]) {
    expect(document.body.textContent).toContain(text);
  }
  await click('Download JSON');
  expect(JSON.parse(download.mock.calls[0]![0].data)).toEqual(periodicResult);
});

it('shows only source-link units, unavailable imported dependencies and overlapping workspace totals in the exact downloaded result', async () => {
  await mount();
  await click('Dismiss');
  const linkedResult = {
    ...result,
    recovery: createRecoveryImportReport(
      recoveryMetadataSchema.parse(links.meta.recovery),
      undefined,
      { model: 'Workspace', imported: 2, skipped: 3, reasons: { INCOMPLETE_DEPENDENCY: 3 } }
    ),
  };
  await act(() => publish(linkedResult));
  const section = document.querySelector('[aria-label="Periodic workspace link recovery"]');
  expect(section?.textContent).toBe(
    'Periodic workspace links: 2 imported, 3 skippedOnly links present in the backup are counted; these counts overlap workspace totals.Skips by reason: workspace or task not created by this import: 3.'
  );
  expect(document.body.textContent).toContain('Workspaces: 3 imported, 4 skipped');
  for (const warning of linkedResult.recovery.warnings) {
    expect(document.body.textContent).toContain(warning);
  }
  await click('Download JSON');
  expect(download).toHaveBeenCalledWith({
    data: JSON.stringify(linkedResult, null, 2),
    mimeType: 'application/json',
    fileName: 'factory-factory-import-result.json',
  });
  await click('Dismiss');
  await act(() => publish(result));
  expect(document.querySelector('[aria-label="Periodic workspace link recovery"]')).toBeNull();
});

it('renders source history versus actual transforms and downloads the exact typed report', async () => {
  await mount();
  await click('Dismiss');
  const historyResult = {
    ...result,
    recovery: createRecoveryImportReport(
      recoveryMetadataSchema.parse(history.meta.recovery),
      undefined,
      undefined,
      {
        model: 'PeriodicTaskExecution',
        imported: 3,
        skipped: 6,
        sourceRunning: 5,
        restoredHistoricalFailed: 2,
        restoredSettled: 1,
        reasons: {
          EXISTING_IDENTITY: 1,
          CONFLICTING_IDENTITY_OR_PARENT: 2,
          INCOMPLETE_DEPENDENCY: 3,
        },
      }
    ),
  };
  await act(() => publish(historyResult));
  const section = document.querySelector('[aria-label="Periodic execution history recovery"]');
  expect(section?.textContent?.replace(/\s+/g, ' ')).toContain(
    'Periodic executions: 3 imported, 6 skipped'
  );
  expect(section?.textContent?.replace(/\s+/g, ' ')).toContain(
    'RUNNING in entire source section: 5; restored FAILED as historical only: 2; restored settled: 1'
  );
  expect(section?.textContent?.replace(/\s+/g, ' ')).toContain(
    'existing execution ID: 1; occupied workspace: 2; dependency not created by this import: 3'
  );
  await click('Download JSON');
  expect(JSON.parse(download.mock.calls[0]![0].data)).toEqual(historyResult);
});

it('keeps and downloads exact definition-body results with all five normative paragraphs', async () => {
  await mount();
  await click('Dismiss');
  const imported = {
    ...result,
    recovery: createRecoveryImportReport(
      recoveryMetadataSchema.parse(definitions.meta.recovery),
      undefined,
      undefined,
      undefined,
      {
        model: 'AgentDefinition',
        imported: 2,
        skipped: 3,
        sourceEnabled: 4,
        restoredDisabled: 2,
        reasons: { EXISTING_IDENTITY: 1, INCOMPLETE_DEPENDENCY: 2 },
      }
    ),
  };
  await act(() => publish(imported));
  const section = document.querySelector('[aria-label="Automation definition body recovery"]');
  expect(
    [...section!.querySelectorAll('p')].map((node) => node.textContent?.replace(/\s+/g, ' ').trim())
  ).toEqual([
    'Automation definition bodies: 2 imported, 3 skipped',
    'Enabled in entire source section: 4; restored disabled: 2',
    'Only definition bodies and execution preferences are restored. Connections, event configuration and automation history are excluded.',
    'Inspect recovered bodies and author new complete event configuration where editing is available.',
    'Skips by reason: existing definition ID: 1; project not created by this import: 2.',
  ]);
  await act(() =>
    root.render(
      <DataImportResultsProvider>
        <Publisher />
        <p>Navigation changed</p>
      </DataImportResultsProvider>
    )
  );
  expect(
    document.querySelector('[aria-label="Automation definition body recovery"]')
  ).not.toBeNull();
  await click('Download JSON');
  expect(download).toHaveBeenCalledWith({
    data: JSON.stringify(imported, null, 2),
    mimeType: 'application/json',
    fileName: 'factory-factory-import-result.json',
  });
});
