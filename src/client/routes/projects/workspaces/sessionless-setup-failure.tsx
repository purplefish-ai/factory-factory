import type { WorkspaceInitBanner } from '@/shared/workspace-init';
import type { WorkspaceRetryAvailability } from '@/shared/workspace-init-retry';
import { useRetryWorkspaceInit } from './use-retry-workspace-init';
import { InitStatusBanner } from './workspace-init-status-banner';

/** Setup recovery must remain reachable before a conversation exists. */
export function SessionlessSetupFailure({
  workspaceId,
  banner,
  errorMessage,
  retryAvailability,
}: {
  workspaceId: string;
  retryAvailability?: WorkspaceRetryAvailability;
  banner: WorkspaceInitBanner | null;
  errorMessage: string | null;
}) {
  const { retry, retryInit } = useRetryWorkspaceInit(workspaceId, retryAvailability);
  return (
    <InitStatusBanner
      banner={{
        kind: 'error',
        message: banner?.message ?? errorMessage ?? 'Workspace setup failed',
        showRetry: true,
        showPlay: false,
        showDismiss: false,
      }}
      retryAvailability={retryAvailability}
      retryPending={retryInit.isPending}
      onRetry={retry}
      onPlay={() => undefined}
    />
  );
}
