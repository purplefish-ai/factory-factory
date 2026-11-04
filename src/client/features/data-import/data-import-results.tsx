import type { inferRouterOutputs } from '@trpc/server';
import { createContext, type ReactElement, type ReactNode, useContext, useState } from 'react';
import { downloadFile } from '@/client/lib/download-file';
import type { AppRouter } from '@/client/lib/trpc';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';

type ImportResult = inferRouterOutputs<AppRouter>['admin']['importData']['results'];
const ImportResultsContext = createContext<{
  publishImportResult: (result: ImportResult) => void;
} | null>(null);

export function useDataImportResults() {
  const context = useContext(ImportResultsContext);
  if (!context) {
    throw new Error('DataImportButton requires DataImportResultsProvider');
  }
  return context;
}

export function DataImportResultsProvider({
  children,
  onDismiss,
}: {
  children: ReactNode;
  onDismiss?: () => void;
}): ReactElement {
  const [pending, setPending] = useState<ImportResult[]>([]);
  const active = pending[0];
  const runtime = active?.inertTransforms;
  const periodic = active?.recovery.periodicConfig;
  const history = active?.recovery.periodicHistory;
  const definitions = active?.recovery.automationDefinitions;
  const links = active?.recovery.periodicWorkspaceLinks;
  return (
    <ImportResultsContext.Provider
      value={{ publishImportResult: (result) => setPending((queue) => [...queue, result]) }}
    >
      {children}
      {active && runtime && (
        <AlertDialog open>
          <AlertDialogContent
            className="max-h-[calc(100dvh-2rem)] flex flex-col"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              onDismiss?.();
            }}
          >
            <AlertDialogHeader>
              <AlertDialogTitle>Import completed</AlertDialogTitle>
              <AlertDialogDescription>
                Actual imported and skipped records and runtime changes.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="min-h-0 overflow-y-auto text-sm space-y-3">
              <div>
                {(
                  [
                    ['Projects', active.projects],
                    ['Workspaces', active.workspaces],
                    ['Agent sessions', active.agentSessions],
                    ['Terminal sessions', active.terminalSessions],
                  ] as const
                ).map(([label, counts]) => (
                  <p key={label}>
                    {label}: {counts.imported} imported, {counts.skipped} skipped
                  </p>
                ))}
                <p>
                  User settings:{' '}
                  {active.userSettings.imported
                    ? 'imported'
                    : active.userSettings.skipped
                      ? 'skipped'
                      : 'none'}
                </p>
              </div>
              {definitions && (
                <section aria-label="Automation definition body recovery">
                  <p>
                    Automation definition bodies: {definitions.imported} imported,{' '}
                    {definitions.skipped} skipped
                  </p>
                  <p>
                    Enabled in entire source section: {definitions.sourceEnabled}; restored
                    disabled: {definitions.restoredDisabled}
                  </p>
                  <p>
                    {active.recovery.manifest?.profile === 'base-json-slack-connections-1'
                      ? 'Only definition bodies and execution preferences are restored. Connection bindings, event configuration and automation history are excluded. Slack connection metadata is reported separately.'
                      : 'Only definition bodies and execution preferences are restored. Connections, event configuration and automation history are excluded.'}
                  </p>
                  <p>
                    Inspect recovered bodies and author new complete event configuration where
                    editing is available.
                  </p>
                  <p>
                    Skips by reason: existing definition ID: {definitions.reasons.EXISTING_IDENTITY}
                    ; project not created by this import:{' '}
                    {definitions.reasons.INCOMPLETE_DEPENDENCY}.
                  </p>
                </section>
              )}
              {history && (
                <section aria-label="Periodic execution history recovery">
                  <p>
                    Periodic executions: {history.imported} imported, {history.skipped} skipped
                  </p>
                  <p>
                    RUNNING in entire source section: {history.sourceRunning}; restored FAILED as
                    historical only: {history.restoredHistoricalFailed}; restored settled:{' '}
                    {history.restoredSettled}
                  </p>
                  <p>
                    Provider outcome is unknown for historical RUNNING executions. Imported
                    executions will not be resumed.
                  </p>
                  <p>
                    Skips by reason: existing execution ID: {history.reasons.EXISTING_IDENTITY}
                    {'; '}
                    occupied workspace: {history.reasons.CONFLICTING_IDENTITY_OR_PARENT}
                    {'; '} dependency not created by this import:{' '}
                    {history.reasons.INCOMPLETE_DEPENDENCY}
                  </p>
                </section>
              )}
              {periodic && (
                <section aria-label="Periodic configuration recovery">
                  <p>
                    Periodic configurations: {periodic.imported} imported, {periodic.skipped}{' '}
                    skipped
                  </p>
                  <p>
                    Enabled in entire source section: {periodic.sourceEnabled}; restored disabled:{' '}
                    {periodic.restoredDisabled}
                  </p>
                  <p>
                    Skips by reason: existing task ID: {periodic.reasons.EXISTING_IDENTITY}; project
                    not created by this import: {periodic.reasons.INCOMPLETE_DEPENDENCY}.
                  </p>
                </section>
              )}
              {links && (
                <section aria-label="Periodic workspace link recovery">
                  <p>
                    Periodic workspace links: {links.imported} imported, {links.skipped} skipped
                  </p>
                  <p>
                    Only links present in the backup are counted; these counts overlap workspace
                    totals.
                  </p>
                  <p>
                    Skips by reason: workspace or task not created by this import:{' '}
                    {links.reasons.INCOMPLETE_DEPENDENCY}.
                  </p>
                </section>
              )}
              <p>
                Runtime changes: {runtime.workspaceWorkflows} workspace workflows need manual
                attention: {runtime.workspaceInitializations} initializations and{' '}
                {runtime.workspaceArchives} archives; {runtime.runScripts} run scripts,{' '}
                {runtime.terminalSessions} terminals and {runtime.agentSessions} agent sessions
                stopped; {runtime.monitors} monitors disabled; {runtime.heldReceipts} receipts held;{' '}
                {runtime.cancelledFacts} pending facts cancelled.
              </p>
              <p className="whitespace-pre-line">{runtime.explanations.join('\n\n')}</p>
              <p>Runtime changes can overlap the record counts above.</p>
              <section aria-label="Partial backup coverage" className="space-y-2">
                <h2 className="font-semibold">Partial backup coverage</h2>
                {active.recovery.warnings.map((warning) => (
                  <p key={warning}>{warning}</p>
                ))}
                {active.recovery.manifest && (
                  <>
                    <p className="break-words">
                      Global exclusions:{' '}
                      {active.recovery.manifest.exclusions
                        .map((exclusion) => exclusion.replaceAll('_', ' ').toLowerCase())
                        .join(', ')}
                    </p>
                    <details>
                      <summary>
                        {active.recovery.manifest.coverage.length} model classifications
                      </summary>
                      <ul className="space-y-2">
                        {active.recovery.manifest.coverage.map((entry) => (
                          <li key={entry.model}>
                            {entry.model}: {entry.status} — {entry.limitation}
                          </li>
                        ))}
                      </ul>
                    </details>
                  </>
                )}
              </section>
              <p>Embedded row totals and account remapping totals: not reported.</p>
            </div>
            <AlertDialogFooter>
              <Button
                variant="outline"
                onClick={() =>
                  downloadFile({
                    data: JSON.stringify(active, null, 2),
                    mimeType: 'application/json',
                    fileName: 'factory-factory-import-result.json',
                  })
                }
              >
                Download JSON
              </Button>
              <AlertDialogCancel onClick={() => setPending((queue) => queue.slice(1))}>
                Dismiss
              </AlertDialogCancel>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </ImportResultsContext.Provider>
  );
}
