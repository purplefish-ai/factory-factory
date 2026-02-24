export const WorkspaceStatus = {
  NEW: 'NEW',
  PROVISIONING: 'PROVISIONING',
  READY: 'READY',
  FAILED: 'FAILED',
  ARCHIVING: 'ARCHIVING',
  ARCHIVED: 'ARCHIVED',
} as const;
export type WorkspaceStatus = (typeof WorkspaceStatus)[keyof typeof WorkspaceStatus];

export const SessionStatus = {
  IDLE: 'IDLE',
  RUNNING: 'RUNNING',
  PAUSED: 'PAUSED',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
} as const;
export type SessionStatus = (typeof SessionStatus)[keyof typeof SessionStatus];

export const PRState = {
  NONE: 'NONE',
  DRAFT: 'DRAFT',
  OPEN: 'OPEN',
  CHANGES_REQUESTED: 'CHANGES_REQUESTED',
  APPROVED: 'APPROVED',
  MERGED: 'MERGED',
  CLOSED: 'CLOSED',
} as const;
export type PRState = (typeof PRState)[keyof typeof PRState];

export const CIStatus = {
  UNKNOWN: 'UNKNOWN',
  PENDING: 'PENDING',
  SUCCESS: 'SUCCESS',
  FAILURE: 'FAILURE',
} as const;
export type CIStatus = (typeof CIStatus)[keyof typeof CIStatus];

export const KanbanColumn = {
  WORKING: 'WORKING',
  WAITING: 'WAITING',
  DONE: 'DONE',
} as const;
export type KanbanColumn = (typeof KanbanColumn)[keyof typeof KanbanColumn];

export const RatchetState = {
  IDLE: 'IDLE',
  CI_RUNNING: 'CI_RUNNING',
  CI_FAILED: 'CI_FAILED',
  REVIEW_PENDING: 'REVIEW_PENDING',
  READY: 'READY',
  MERGED: 'MERGED',
} as const;
export type RatchetState = (typeof RatchetState)[keyof typeof RatchetState];

export const WorkspaceCreationSource = {
  MANUAL: 'MANUAL',
  RESUME_BRANCH: 'RESUME_BRANCH',
  GITHUB_ISSUE: 'GITHUB_ISSUE',
  LINEAR_ISSUE: 'LINEAR_ISSUE',
} as const;
export type WorkspaceCreationSource =
  (typeof WorkspaceCreationSource)[keyof typeof WorkspaceCreationSource];

export const IssueProvider = {
  GITHUB: 'GITHUB',
  LINEAR: 'LINEAR',
} as const;
export type IssueProvider = (typeof IssueProvider)[keyof typeof IssueProvider];

export const RunScriptStatus = {
  IDLE: 'IDLE',
  STARTING: 'STARTING',
  RUNNING: 'RUNNING',
  STOPPING: 'STOPPING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
} as const;
export type RunScriptStatus = (typeof RunScriptStatus)[keyof typeof RunScriptStatus];
