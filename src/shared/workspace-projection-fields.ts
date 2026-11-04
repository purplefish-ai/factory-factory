import type { WorkspaceSummary } from './workspace-summary';

export const SNAPSHOT_FIELD_GROUPS = [
  'workspace',
  'pr',
  'session',
  'ratchet',
  'runScript',
  'reconciliation',
  'git',
  'metadata',
] as const;
export type SnapshotFieldGroup = (typeof SNAPSHOT_FIELD_GROUPS)[number];

/** Raw inputs only; selection and presentation state are derived after acceptance. */
export type SnapshotUpdateInput = Partial<
  Omit<
    WorkspaceSummary,
    | 'id'
    | 'selectedPrId'
    | 'selectedPr'
    | 'kanbanColumn'
    | 'waitingSince'
    | 'sidebarStatus'
    | 'ratchetButtonAnimated'
    | 'flowPhase'
    | 'ciObservation'
    | 'statusReason'
  > & {
    hasHadSessions: boolean;
    prUpdatedAt: string | null;
    hasMergeConflict: boolean;
    /** Private DB provenance, never serialized. */
    nameUpdatedAt: number;
    branchUpdatedAt: number;
  }
>;

type FieldPolicy = {
  group: SnapshotFieldGroup | 'name' | 'branch' | 'provenance';
  required: boolean;
  drift: SnapshotFieldGroup | 'name' | 'branch' | { excluded: string };
};

/** Every raw field must declare merge, hydration and drift semantics here. */
export const workspaceProjectionPolicy = {
  conversationSummary: { group: 'metadata', required: false, drift: 'metadata' },
  projectId: {
    group: 'workspace',
    required: true,
    drift: { excluded: 'identity/index ownership' },
  },
  name: { group: 'name', required: true, drift: 'name' },
  nameUpdatedAt: {
    group: 'provenance',
    required: false,
    drift: { excluded: 'private name fence' },
  },
  status: { group: 'workspace', required: true, drift: 'workspace' },
  createdAt: { group: 'workspace', required: true, drift: { excluded: 'immutable creation time' } },
  branchName: { group: 'branch', required: true, drift: 'branch' },
  branchUpdatedAt: {
    group: 'provenance',
    required: false,
    drift: { excluded: 'private branch fence' },
  },
  hasHadSessions: {
    group: 'workspace',
    required: true,
    drift: { excluded: 'session history input' },
  },
  prs: { group: 'pr', required: true, drift: 'pr' },
  prCollectionRevision: { group: 'pr', required: false, drift: 'pr' },
  prSummary: { group: 'pr', required: true, drift: 'pr' },
  prUrl: {
    group: 'pr',
    required: true,
    drift: { excluded: 'legacy PR link; collection is compared' },
  },
  prNumber: { group: 'pr', required: true, drift: 'pr' },
  prState: { group: 'pr', required: true, drift: 'pr' },
  prCiStatus: { group: 'pr', required: true, drift: 'pr' },
  prUpdatedAt: { group: 'pr', required: true, drift: { excluded: 'volatile PR observation time' } },
  hasMergeConflict: {
    group: 'pr',
    required: true,
    drift: { excluded: 'legacy flag; PR summary is compared' },
  },
  isWorking: { group: 'session', required: true, drift: 'session' },
  pendingRequestType: { group: 'session', required: true, drift: 'session' },
  sessionSummaries: { group: 'session', required: true, drift: 'session' },
  ratchetEnabled: { group: 'ratchet', required: true, drift: 'ratchet' },
  ratchetState: { group: 'ratchet', required: true, drift: 'ratchet' },
  prMonitoring: { group: 'ratchet', required: true, drift: 'ratchet' },
  runScriptStatus: { group: 'runScript', required: true, drift: 'runScript' },
  gitStats: {
    group: 'git',
    required: false,
    drift: { excluded: 'separately refreshed Git cache' },
  },
  lastActivityAt: {
    group: 'reconciliation',
    required: true,
    drift: { excluded: 'volatile activity time' },
  },
  worktreePath: { group: 'metadata', required: true, drift: 'metadata' },
  defaultSessionProvider: { group: 'metadata', required: false, drift: 'metadata' },
  initErrorMessage: { group: 'metadata', required: true, drift: 'metadata' },
  githubIssueNumber: { group: 'metadata', required: true, drift: 'metadata' },
  githubIssueUrl: { group: 'metadata', required: true, drift: 'metadata' },
  linearIssueId: { group: 'metadata', required: true, drift: 'metadata' },
  linearIssueIdentifier: { group: 'metadata', required: true, drift: 'metadata' },
  linearIssueUrl: { group: 'metadata', required: true, drift: 'metadata' },
  creationSource: { group: 'metadata', required: true, drift: 'metadata' },
  parentWorkspace: { group: 'metadata', required: false, drift: 'metadata' },
  childWorkspaceCount: { group: 'metadata', required: false, drift: 'metadata' },
} as const satisfies Record<keyof SnapshotUpdateInput, FieldPolicy>;

export type SnapshotInputField = keyof SnapshotUpdateInput;
export type SnapshotField = Exclude<SnapshotInputField, 'nameUpdatedAt' | 'branchUpdatedAt'>;

// Narrow the keys of this closed literal once, without widening the public inventory.
const fields = Object.keys(workspaceProjectionPolicy) as SnapshotInputField[];
export const snapshotRequiredFields = fields.filter(
  (field): field is SnapshotField => workspaceProjectionPolicy[field].required
);
export const snapshotFieldGroups = SNAPSHOT_FIELD_GROUPS.map((group) => ({
  group,
  fields: fields.filter(
    (field): field is SnapshotField => workspaceProjectionPolicy[field].group === group
  ),
}));
export const snapshotDriftFields = fields.flatMap((field) => {
  const drift = workspaceProjectionPolicy[field].drift;
  return typeof drift === 'string' && field !== 'nameUpdatedAt' && field !== 'branchUpdatedAt'
    ? [{ field, group: drift }]
    : [];
});
export const snapshotMetadataMask = Object.fromEntries(
  fields
    .filter((field) => workspaceProjectionPolicy[field].group === 'metadata')
    .map((field) => [field, true])
) as {
  [
    K in SnapshotInputField as (typeof workspaceProjectionPolicy)[K]['group'] extends 'metadata'
      ? K
      : never
  ]: true;
};
