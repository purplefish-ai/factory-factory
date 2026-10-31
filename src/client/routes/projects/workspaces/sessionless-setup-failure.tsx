import type { WorkspaceInitBanner } from '@/shared/workspace-init';
import { useRetryWorkspaceInit } from './use-retry-workspace-init';
import { InitStatusBanner } from './workspace-init-status-banner';

/** Setup recovery must remain reachable before a conversation exists. */
export function SessionlessSetupFailure({
  workspaceId,
  banner,
  errorMessage,
}: {
  workspaceId: string;
  banner: WorkspaceInitBanner | null;
  errorMessage: string | null;
}) {
  const { retry, retryInit } = useRetryWorkspaceInit(workspaceId);
  return (
    <InitStatusBanner
      banner={{
        kind: 'error',
        message: banner?.message ?? errorMessage ?? 'Workspace setup failed',
        showRetry: true,
        showPlay: false,
        showDismiss: false,
      }}
      retryPending={retryInit.isPending}
      onRetry={retry}
      onPlay={() => undefined}
    />
  );
}
