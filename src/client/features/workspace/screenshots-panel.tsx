import { CameraIcon } from '@phosphor-icons/react/dist/csr/Camera';
import { WarningCircleIcon } from '@phosphor-icons/react/dist/csr/WarningCircle';
import { XIcon } from '@phosphor-icons/react/dist/csr/X';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { EmptyState } from '@/client/components/empty-state';
import { QueryState } from '@/client/components/query-state';
import { POLL_INTERVAL_MS } from '@/client/lib/query-options';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { useWorkspacePanel } from './workspace-panel-context';

// =============================================================================
// Types
// =============================================================================

type Screenshot = { name: string; path: string; size: number };

interface ScreenshotsPanelProps {
  workspaceId: string;
  isTakingScreenshots: boolean;
  onTakeScreenshots?: () => void;
}

// =============================================================================
// Main Component
// =============================================================================

export function ScreenshotsPanel({
  workspaceId,
  isTakingScreenshots,
  onTakeScreenshots,
}: ScreenshotsPanelProps) {
  const { openTab } = useWorkspacePanel();
  const utils = trpc.useUtils();

  // Deleting unlinks the file from the worktree, so it is confirmed first. The
  // target outlives the open flag so the dialog text stays put while closing.
  const [deleteTarget, setDeleteTarget] = useState<Screenshot | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const deleteMutation = trpc.workspace.deleteScreenshot.useMutation({
    onSuccess: () => {
      setDeleteDialogOpen(false);
      void utils.workspace.listScreenshots.invalidate({ workspaceId });
    },
    onError: (error) => {
      // Keep the dialog open so the delete can be retried.
      toast.error("Couldn't delete screenshot.", { description: error.message });
    },
  });

  const screenshotsQuery = trpc.workspace.listScreenshots.useQuery(
    { workspaceId },
    {
      refetchInterval: isTakingScreenshots ? POLL_INTERVAL_MS.capture : POLL_INTERVAL_MS.activity,
      staleTime: isTakingScreenshots ? 1000 : 5000,
    }
  );

  const screenshots = screenshotsQuery.data?.screenshots ?? [];
  const deleteTargetListed =
    deleteTarget !== null && screenshots.some((shot) => shot.path === deleteTarget.path);

  // Close the confirmation if its screenshot leaves the list (deleted elsewhere,
  // or the list emptied/failed), so it cannot reopen later with a stale target.
  if (deleteDialogOpen && !deleteMutation.isPending && !deleteTargetListed) {
    setDeleteDialogOpen(false);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <QueryState
        query={screenshotsQuery}
        errorTitle="Couldn't load screenshots"
        loadingMessage="Loading screenshots…"
        size="compact"
        className="h-full"
        isEmpty={(data) => data.screenshots.length === 0}
        empty={
          <ScreenshotsEmptyState
            isTakingScreenshots={isTakingScreenshots}
            onTakeScreenshots={onTakeScreenshots}
          />
        }
      >
        {(data) => (
          <ScrollArea className="min-h-0 flex-1">
            <div className="p-2 grid grid-cols-2 gap-2">
              {data.screenshots.map((screenshot) => (
                <ScreenshotThumbnail
                  key={screenshot.path}
                  workspaceId={workspaceId}
                  screenshot={screenshot}
                  onClick={() => openTab('screenshot', screenshot.path, screenshot.name)}
                  onDelete={() => {
                    setDeleteTarget(screenshot);
                    setDeleteDialogOpen(true);
                  }}
                />
              ))}
            </div>
          </ScrollArea>
        )}
      </QueryState>
      <ConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title="Delete screenshot?"
        description={`"${deleteTarget?.name ?? ''}" will be permanently deleted from this workspace. This can't be undone.`}
        confirmText="Delete"
        pendingText="Deleting…"
        variant="destructive"
        isPending={deleteMutation.isPending}
        onConfirm={() => {
          if (deleteTarget) {
            deleteMutation.mutate({ workspaceId, path: deleteTarget.path });
          }
        }}
      />
    </div>
  );
}

// =============================================================================
// Empty State
// =============================================================================

function ScreenshotsEmptyState({
  isTakingScreenshots,
  onTakeScreenshots,
}: Pick<ScreenshotsPanelProps, 'isTakingScreenshots' | 'onTakeScreenshots'>) {
  const handleTakeScreenshots = useCallback(() => {
    onTakeScreenshots?.();
  }, [onTakeScreenshots]);

  if (isTakingScreenshots) {
    return (
      <EmptyState
        size="compact"
        icon={CameraIcon}
        title="Taking screenshots…"
        description="The agent is capturing the dev app."
        action={<Spinner className="size-5 text-muted-foreground" aria-hidden="true" />}
        className="h-full"
      />
    );
  }

  return (
    <EmptyState
      size="compact"
      icon={CameraIcon}
      title="No screenshots yet"
      description="Capture screenshots of the running dev app."
      action={
        onTakeScreenshots ? (
          <Button variant="outline" size="sm" onClick={handleTakeScreenshots}>
            <CameraIcon aria-hidden="true" />
            Take screenshots
          </Button>
        ) : null
      }
      className="h-full"
    />
  );
}

// =============================================================================
// Thumbnail Component
// =============================================================================

interface ScreenshotThumbnailProps {
  workspaceId: string;
  screenshot: Screenshot;
  onClick: () => void;
  onDelete: () => void;
}

function ScreenshotThumbnail({
  workspaceId,
  screenshot,
  onClick,
  onDelete,
}: ScreenshotThumbnailProps) {
  const { data, error, isLoading } = trpc.workspace.readScreenshot.useQuery(
    { workspaceId, path: screenshot.path },
    { staleTime: 60_000 }
  );

  const handleDelete = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onDelete();
    },
    [onDelete]
  );

  return (
    <div className="group relative aspect-video rounded-md border bg-muted/30 overflow-hidden hover:border-primary/50 transition-colors cursor-pointer">
      <button
        type="button"
        onClick={onClick}
        aria-label={`Open screenshot ${screenshot.name}`}
        className="absolute inset-0"
      >
        {isLoading ? (
          <Skeleton className="absolute inset-0 rounded-none" aria-hidden="true" />
        ) : data ? (
          <img
            src={`data:${data.mimeType};base64,${data.data}`}
            alt={screenshot.name}
            className="absolute inset-0 w-full h-full object-cover"
          />
        ) : error ? (
          // Opening the screenshot shows the full error with Retry.
          <span
            className="absolute inset-0 flex flex-col items-center justify-center gap-1 p-2 text-xs text-muted-foreground"
            title={error.message}
          >
            <WarningCircleIcon className="size-4 text-destructive" aria-hidden="true" />
            Couldn't load preview
          </span>
        ) : null}
      </button>
      <div className="absolute top-1 right-1 hover-reveal transition-opacity">
        <button
          type="button"
          onClick={handleDelete}
          aria-label={`Delete screenshot ${screenshot.name}`}
          className="h-5 w-5 flex items-center justify-center rounded-full bg-black/60 text-white hover:bg-destructive dark:hover:bg-destructive/60 transition-colors"
        >
          <XIcon className="h-3 w-3" />
        </button>
      </div>
      <div className="pointer-events-none absolute bottom-0 left-0 right-0 bg-black/60 px-1.5 py-0.5 text-2xs text-white truncate">
        {screenshot.name}
      </div>
    </div>
  );
}
