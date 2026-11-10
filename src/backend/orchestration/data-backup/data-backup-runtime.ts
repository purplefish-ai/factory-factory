import type { ExportData } from '@/shared/schemas/export-data.schema';

export function createInertImportReport() {
  return {
    workspaceWorkflows: 0,
    workspaceInitializations: 0,
    workspaceArchives: 0,
    runScripts: 0,
    terminalSessions: 0,
    agentSessions: 0,
    monitors: 0,
    heldReceipts: 0,
    cancelledFacts: 0,
    explanations: [
      'Restored processes remain stopped. Start them manually when ready.',
      'Unfinished workspace initialization and archiving require manual recovery; original status is retained in the workspace error.',
      'PR monitoring is disabled. Unsettled imported receipts remain blocked even after reenable; unclaimed pending facts are cancelled without claiming delivery.',
    ],
  };
}
export type InertImportReport = ReturnType<typeof createInertImportReport>;

export function recordStoppedProcess(
  report: InertImportReport,
  category: 'agentSessions' | 'terminalSessions',
  status: string,
  pid: number | null
) {
  report[category] += Number(status === 'RUNNING' || pid !== null);
}

/** Called only after a workspace has passed the existing-row and parent checks. */
export function inertWorkspaceRuntime(
  workspace: ExportData['data']['workspaces'][number],
  report: InertImportReport
) {
  const unfinished = ['NEW', 'PROVISIONING', 'ARCHIVING'].includes(workspace.status);
  const running = ['STARTING', 'RUNNING', 'STOPPING'].includes(workspace.runScriptStatus);
  if (unfinished) {
    report.workspaceWorkflows++;
    report.workspaceInitializations += Number(workspace.status !== 'ARCHIVING');
    report.workspaceArchives += Number(workspace.status === 'ARCHIVING');
  }
  if (
    running ||
    workspace.runScriptPid !== null ||
    workspace.runScriptPort !== null ||
    workspace.runScriptStartedAt !== null
  ) {
    report.runScripts++;
  }
  const explanation = `Restored from ${workspace.status}; workflow was not resumed. Review and recover manually.`;
  return {
    status: unfinished ? ('FAILED' as const) : workspace.status,
    initErrorMessage: unfinished
      ? [workspace.initErrorMessage, explanation].filter(Boolean).join('\n')
      : workspace.initErrorMessage,
    initStartedAt: unfinished
      ? null
      : workspace.initStartedAt
        ? new Date(workspace.initStartedAt)
        : null,
    initScriptPid: null,
    runScript: {
      create: {
        command: workspace.runScriptCommand,
        cleanupCommand: workspace.runScriptCleanupCommand,
        pid: null,
        port: null,
        startedAt: null,
        status: running ? ('IDLE' as const) : workspace.runScriptStatus,
      },
    },
  };
}
