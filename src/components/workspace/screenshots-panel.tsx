import { Camera, Loader2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';

import { useWorkspacePanel } from './workspace-panel-context';

// =============================================================================
// Types
// =============================================================================

interface ScreenshotsPanelProps {
  workspaceId: string;
  onTakeScreenshots?: () => void;
}

// =============================================================================
// Main Component
// =============================================================================

export function ScreenshotsPanel({ workspaceId, onTakeScreenshots }: ScreenshotsPanelProps) {
  const { openTab } = useWorkspacePanel();
  const utils = trpc.useUtils();
  const [isTaking, setIsTaking] = useState(false);
  const prevCountRef = useRef(0);

  const deleteMutation = trpc.workspace.deleteScreenshot.useMutation({
    onSuccess: () => {
      void utils.workspace.listScreenshots.invalidate({ workspaceId });
    },
  });

  const { data, isLoading } = trpc.workspace.listScreenshots.useQuery(
    { workspaceId },
    { refetchInterval: isTaking ? 3000 : 10_000, staleTime: isTaking ? 1000 : 5000 }
  );

  const screenshots = data?.screenshots ?? [];

  // Clear isTaking when new screenshots appear
  useEffect(() => {
    if (isTaking && screenshots.length > prevCountRef.current) {
      setIsTaking(false);
    }
    prevCountRef.current = screenshots.length;
  }, [screenshots.length, isTaking]);

  const handleTakeScreenshots = useCallback(() => {
    setIsTaking(true);
    onTakeScreenshots?.();
  }, [onTakeScreenshots]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (screenshots.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center p-4 gap-3">
        <Camera className="h-8 w-8 text-muted-foreground" />
        <div>
          {isTaking ? (
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
        {isTaking ? (
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        ) : (
          onTakeScreenshots && (
            <Button variant="outline" size="sm" onClick={handleTakeScreenshots} className="gap-1.5">
              <Camera className="h-3.5 w-3.5" />
              Take Screenshots
            </Button>
          )
        )}
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="p-2 grid grid-cols-2 gap-2">
        {screenshots.map((screenshot) => (
          <ScreenshotThumbnail
            key={screenshot.path}
            workspaceId={workspaceId}
            screenshot={screenshot}
            onClick={() => openTab('screenshot', screenshot.path, screenshot.name)}
            onDelete={() => deleteMutation.mutate({ workspaceId, path: screenshot.path })}
          />
        ))}
      </div>
    </ScrollArea>
  );
}

// =============================================================================
// Thumbnail Component
// =============================================================================

interface ScreenshotThumbnailProps {
  workspaceId: string;
  screenshot: { name: string; path: string; size: number };
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
    <button
      type="button"
      onClick={onClick}
      className="group relative aspect-video rounded-md border bg-muted/30 overflow-hidden hover:border-primary/50 transition-colors cursor-pointer"
    >
      {isLoading ? (
        <div className="flex items-center justify-center h-full">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      ) : data ? (
        <img
          src={`data:${data.mimeType};base64,${data.data}`}
          alt={screenshot.name}
          className="absolute inset-0 w-full h-full object-cover"
        />
      ) : null}
      <div className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          type="button"
          onClick={handleDelete}
          className="h-5 w-5 flex items-center justify-center rounded-full bg-black/60 text-white hover:bg-red-600 transition-colors"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      <div className="absolute bottom-0 left-0 right-0 bg-black/60 px-1.5 py-0.5 text-[10px] text-white truncate">
        {screenshot.name}
      </div>
    </button>
  );
}
