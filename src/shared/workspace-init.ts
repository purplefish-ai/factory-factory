export type WorkspaceInitPhase =
  | 'CREATING_WORKTREE'
  | 'RUNNING_INIT_SCRIPT'
  | 'READY'
  | 'BLOCKED_FAILED'
  | 'READY_WITH_WARNING'
  | 'ARCHIVED';

export type WorkspaceInitBanner = {
  kind: 'info' | 'warning' | 'error';
  message: string;
  showRetry: boolean;
  showPlay: boolean;
};
