import { CameraIcon } from '@phosphor-icons/react/dist/csr/Camera';
import { SpinnerGapIcon } from '@phosphor-icons/react/dist/csr/SpinnerGap';
import { XIcon } from '@phosphor-icons/react/dist/csr/X';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { QueryErrorState } from '@/client/components/query-error-state';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
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
      toast.error("Couldn't delete screenshot", { description: error.message });
    },
  });

  const { data, isLoading, error, isFetching, refetch } = trpc.workspace.listScreenshots.useQuery(
    { workspaceId },
    {
      refetchInterval: isTakingScreenshots ? 3000 : 10_000,
      staleTime: isTakingScreenshots ? 1000 : 5000,
    }
  );

  const screenshots = data?.screenshots ?? [];
  const deleteTargetListed =
    deleteTarget !== null && screenshots.some((shot) => shot.path === deleteTarget.path);

  // Close the confirmation if its screenshot leaves the list (deleted elsewhere,
  // or the list emptied/failed), so it cannot reopen later with a stale target.
  useEffect(() => {
    if (deleteDialogOpen && !deleteMutation.isPending && !deleteTargetListed) {
      setDeleteDialogOpen(false);
    }
  }, [deleteDialogOpen, deleteMutation.isPending, deleteTargetListed]);

  let body: ReactNode;
  if (isLoading) {
    body = (
      <div className="flex items-center justify-center h-full">
        <SpinnerGapIcon className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  } else if (error && !data) {
    body = (
      <QueryErrorState
        title="Couldn't load screenshots"
        error={error}
        onRetry={() => {
          void refetch();
        }}
        isRetrying={isFetching}
        className="h-full"
      />
    );
  } else if (screenshots.length === 0) {
    body = (
      <ScreenshotsEmptyState
        isTakingScreenshots={isTakingScreenshots}
        onTakeScreenshots={onTakeScreenshots}
      />
    );
  } else {
    body = (
      <ScrollArea className="h-full">
        <div className="p-2 grid grid-cols-2 gap-2">
          {screenshots.map((screenshot) => (
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
    );
  }

  return (
    <>
      {body}
      <ConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={(open) => {
          if (!(open || deleteMutation.isPending)) {
            setDeleteDialogOpen(false);
          }
        }}
        title="Delete screenshot?"
        description={`"${deleteTarget?.name ?? ''}" will be permanently deleted from this workspace. This can't be undone.`}
        confirmText="Delete"
        variant="destructive"
        isPending={deleteMutation.isPending}
        onConfirm={() => {
          if (deleteTarget) {
            deleteMutation.mutate({ workspaceId, path: deleteTarget.path });
          }
        }}
      />
    </>
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

  return (
    <div className="flex flex-col items-center justify-center h-full text-center p-4 gap-3">
      <CameraIcon className="h-8 w-8 text-muted-foreground" />
      <div>
        {isTakingScreenshots ? (
          <>
            <p className="text-sm font-medium text-muted-foreground">Taking Screenshots...</p>
            <p className="text-xs text-muted-foreground/70 mt-1">
              The agent is capturing the dev app
            </p>
          </>
        ) : (
          <>
            <p className="text-sm font-medium text-muted-foreground">No screenshots yet</p>
            <p className="text-xs text-muted-foreground/70 mt-1">
              Capture screenshots of the running dev app
            </p>
          </>
        )}
      </div>
      {isTakingScreenshots ? (
        <SpinnerGapIcon className="h-5 w-5 animate-spin text-muted-foreground" />
      ) : (
        onTakeScreenshots && (
          <Button variant="outline" size="sm" onClick={handleTakeScreenshots} className="gap-1.5">
            <CameraIcon className="h-3.5 w-3.5" />
            Take Screenshots
          </Button>
        )
      )}
    </div>
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
  const { data, isLoading } = trpc.workspace.readScreenshot.useQuery(
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
          <div className="flex items-center justify-center h-full">
            <SpinnerGapIcon className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : data ? (
          <img
            src={`data:${data.mimeType};base64,${data.data}`}
            alt={screenshot.name}
            className="absolute inset-0 w-full h-full object-cover"
          />
        ) : null}
      </button>
      <div className="absolute top-1 right-1 hover-reveal transition-opacity">
        <button
          type="button"
          onClick={handleDelete}
          aria-label={`Delete screenshot ${screenshot.name}`}
          className="h-5 w-5 flex items-center justify-center rounded-full bg-black/60 text-white hover:bg-destructive transition-colors"
        >
          <XIcon className="h-3 w-3" />
        </button>
      </div>
      <div className="pointer-events-none absolute bottom-0 left-0 right-0 bg-black/60 px-1.5 py-0.5 text-[10px] text-white truncate">
        {screenshot.name}
      </div>
    </div>
  );
}
