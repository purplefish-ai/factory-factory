import type { RecoveryMetadata } from './schemas/recovery-envelope.schema';

export interface PeriodicConfigImportReport {
  model: 'PeriodicTask';
  imported: number;
  skipped: number;
  sourceEnabled: number;
  restoredDisabled: number;
  reasons: { EXISTING_IDENTITY: number; INCOMPLETE_DEPENDENCY: number };
}

export interface AutomationDefinitionsImportReport extends Omit<
  PeriodicConfigImportReport,
  'model'
> {
  model: 'AgentDefinition';
}

export interface PeriodicWorkspaceLinksImportReport {
  model: 'Workspace';
  imported: number;
  skipped: number;
  reasons: { INCOMPLETE_DEPENDENCY: number };
}

export interface PeriodicHistoryImportReport {
  model: 'PeriodicTaskExecution';
  imported: number;
  skipped: number;
  sourceRunning: number;
  restoredHistoricalFailed: number;
  restoredSettled: number;
  reasons: {
    EXISTING_IDENTITY: number;
    CONFLICTING_IDENTITY_OR_PARENT: number;
    INCOMPLETE_DEPENDENCY: number;
  };
}

export interface SlackConnectionsImportReport extends Omit<
  PeriodicConfigImportReport,
  'model' | 'reasons'
> {
  model: 'AgentConnection';
  reasons: { EXISTING_IDENTITY: number };
}

export interface RecoveryImportReport {
  slackConnections?: SlackConnectionsImportReport;
  automationDefinitions?: AutomationDefinitionsImportReport;
  periodicHistory?: PeriodicHistoryImportReport;
  periodicWorkspaceLinks?: PeriodicWorkspaceLinksImportReport;
  periodicConfig?: PeriodicConfigImportReport;
  status: 'PARTIAL';
  manifest: RecoveryMetadata | null;
  warnings: string[];
  unreportedTotals: 'EMBEDDED_ROWS_AND_ACCOUNT_MAPPINGS';
}
function includesPeriodicHistory(metadata: RecoveryMetadata | undefined): boolean {
  return (
    metadata?.profile === 'base-json-periodic-history-1' ||
    metadata?.profile === 'base-json-automation-definitions-1' ||
    metadata?.profile === 'base-json-slack-connections-1'
  );
}
function physicalFidelityWarning(metadata: RecoveryMetadata | undefined): string {
  return includesPeriodicHistory(metadata)
    ? 'Partial logical metadata only; physical nullable-JSON fidelity is supported for Workspace.creationMetadata, WorkspacePR.observation on actual included PR rows, AgentSession.providerMetadata, and PeriodicTaskExecution.launchSnapshot. Omitted domains are not restored.'
    : metadata?.profile === 'base-json-1' ||
        metadata?.profile === 'base-json-periodic-config-1' ||
        metadata?.profile === 'base-json-periodic-links-1'
      ? 'Partial logical metadata only; physical nullable-JSON fidelity is supported for Workspace.creationMetadata, WorkspacePR.observation on actual included PR rows, and AgentSession.providerMetadata. Omitted domains are not restored.'
      : metadata?.profile === 'base-json-workspace-1'
        ? 'Partial logical metadata only; physical nullable-JSON fidelity is supported for Workspace.creationMetadata only. WorkspacePR.observation and AgentSession.providerMetadata physical nullable-JSON fidelity is unproven. Omitted domains are not restored.'
        : 'Partial logical metadata only; physical nullable-JSON fidelity is unproven. Omitted domains are not restored.';
}

function definitionConnectionScope(metadata: RecoveryMetadata | undefined): string {
  return metadata?.profile === 'base-json-slack-connections-1'
    ? 'Connection bindings'
    : 'Connections';
}

function slackConnectionWarnings(
  slackConnections: SlackConnectionsImportReport | undefined
): string[] {
  return slackConnections
    ? [
        `Slack connection metadata restored disabled: ${slackConnections.imported} imported, ${slackConnections.skipped} skipped; ${slackConnections.sourceEnabled} enabled in the entire source section; ${slackConnections.restoredDisabled} restored disabled without credentials. Skips by reason: existing connection ID or Slack workspace identity: ${slackConnections.reasons.EXISTING_IDENTITY}. Reconnect a workspace manually in Slack settings using a new bot token. GitHub connections, connection bindings, event configuration, activation and event-triggered run history are excluded.`,
      ]
    : [];
}

export function createRecoveryImportReport(
  metadata: RecoveryMetadata | undefined,
  periodicConfig?: PeriodicConfigImportReport,
  periodicWorkspaceLinks?: PeriodicWorkspaceLinksImportReport,
  periodicHistory?: PeriodicHistoryImportReport,
  automationDefinitions?: AutomationDefinitionsImportReport,
  slackConnections?: SlackConnectionsImportReport
): RecoveryImportReport {
  return {
    ...(slackConnections ? { slackConnections } : {}),
    ...(automationDefinitions ? { automationDefinitions } : {}),
    ...(periodicHistory ? { periodicHistory } : {}),
    ...(periodicConfig ? { periodicConfig } : {}),
    ...(periodicWorkspaceLinks ? { periodicWorkspaceLinks } : {}),
    status: 'PARTIAL',
    manifest: metadata ?? null,
    warnings: [
      ...(!metadata ? ['This legacy backup has no versioned coverage declaration.'] : []),
      physicalFidelityWarning(metadata),
      'Paths and provider-session IDs may be metadata; repository/worktree files, provider history bytes, secrets, native account homes and live runtime authority are excluded.',
      ...(periodicConfig
        ? [
            `Scheduled automation configuration restored disabled: ${periodicConfig.imported} imported, ${periodicConfig.skipped} skipped; ${periodicConfig.sourceEnabled} enabled in the entire source section; ${periodicConfig.restoredDisabled} restored disabled. Skips by reason: existing automation ID: ${periodicConfig.reasons.EXISTING_IDENTITY}; project not created by this import: ${periodicConfig.reasons.INCOMPLETE_DEPENDENCY}.${includesPeriodicHistory(metadata) ? '' : ' Scheduled run history excluded.'}`,
          ]
        : []),
      ...(periodicWorkspaceLinks
        ? [
            `Scheduled automation workspace links: ${periodicWorkspaceLinks.imported} imported, ${periodicWorkspaceLinks.skipped} skipped. Only links present in the backup are counted; these counts overlap workspace totals. Skips mean the workspace or automation was not created by this import. Linked automations are restored disabled${includesPeriodicHistory(metadata) ? '.' : '; scheduled run history is excluded.'}`,
          ]
        : []),
      ...(automationDefinitions
        ? [
            `Automation definition bodies restored disabled: ${automationDefinitions.imported} imported, ${automationDefinitions.skipped} skipped; ${automationDefinitions.sourceEnabled} enabled in the entire source section; ${automationDefinitions.restoredDisabled} restored disabled. Skips by reason: existing definition ID: ${automationDefinitions.reasons.EXISTING_IDENTITY}; project not created by this import: ${automationDefinitions.reasons.INCOMPLETE_DEPENDENCY}. ${definitionConnectionScope(metadata)}, event configuration, proposal provenance, activation and event-triggered run history are excluded. Inspect recovered bodies and author new complete event configuration where editing is available.`,
          ]
        : []),
      ...slackConnectionWarnings(slackConnections),
      ...(periodicHistory
        ? [
            `Scheduled run history: ${periodicHistory.imported} imported, ${periodicHistory.skipped} skipped; ${periodicHistory.sourceRunning} RUNNING in the entire source section; ${periodicHistory.restoredHistoricalFailed} restored FAILED as historical only, provider outcome unknown; ${periodicHistory.restoredSettled} restored settled. Skips by reason: existing run ID: ${periodicHistory.reasons.EXISTING_IDENTITY}; occupied workspace: ${periodicHistory.reasons.CONFLICTING_IDENTITY_OR_PARENT}; dependency not created by this import: ${periodicHistory.reasons.INCOMPLETE_DEPENDENCY}. Imported runs will not be resumed.`,
          ]
        : []),
    ],
    unreportedTotals: 'EMBEDDED_ROWS_AND_ACCOUNT_MAPPINGS',
  };
}
