import { lazy, Suspense, useState } from 'react';
import { Loading } from '@/client/components/loading';
import { ErrorBoundary } from '@/client/error-boundary';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { useKanbanState } from './kanban-context';

// Quick Chat renders the chat transcript and its markdown renderer, about half a
// megabyte the board itself never shows. Load it on the first open.
const QuickChatSheet = lazy(() =>
  import('./quick-chat-sheet').then((module) => ({ default: module.QuickChatSheet }))
);

interface LazyQuickChatSheetProps {
  workspaceId: string | null;
  onClose: () => void;
}

interface QuickChatFallbackSheetProps {
  open: boolean;
  /** The workspace name, as the loaded sheet titles it. */
  title: string;
  onClose: () => void;
  failed?: boolean;
}

/** The sheet shown while Quick Chat loads, or when its chunk fails to load. */
export function QuickChatFallbackSheet({
  open,
  title,
  onClose,
  failed,
}: QuickChatFallbackSheetProps) {
  return (
    <Sheet open={open} onOpenChange={(value) => !value && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-2xl flex flex-col p-0">
        <SheetHeader className="px-4 pt-4 pb-0 shrink-0">
          <SheetTitle className="text-base leading-tight pr-8 truncate">{title}</SheetTitle>
          <SheetDescription className="sr-only">
            Chat with the agent for this workspace
          </SheetDescription>
        </SheetHeader>
        <div className="flex-1 min-h-0">
          {failed ? (
            <div role="alert" className="flex flex-col items-center gap-3 p-4 text-sm">
              Couldn't load Quick Chat. Reload the app to try again.
              <Button size="sm" onClick={() => window.location.reload()}>
                Reload
              </Button>
            </div>
          ) : (
            <Loading size="compact" message="Loading chat…" />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function QuickChatFallback({
  workspaceId,
  onClose,
  failed,
}: LazyQuickChatSheetProps & { failed?: boolean }) {
  const { workspaces } = useKanbanState();
  return (
    <QuickChatFallbackSheet
      open={!!workspaceId}
      title={workspaces?.find((workspace) => workspace.id === workspaceId)?.name ?? 'Quick Chat'}
      onClose={onClose}
      failed={failed}
    />
  );
}

export function LazyQuickChatSheet({ workspaceId, onClose }: LazyQuickChatSheetProps) {
  // Once opened the sheet stays mounted: it owns per-session scroll positions across
  // reopenings and plays its own close animation.
  const [opened, setOpened] = useState(false);
  if (workspaceId && !opened) {
    setOpened(true);
  }
  if (!(opened || workspaceId)) {
    return null;
  }
  return (
    <ErrorBoundary
      fallback={<QuickChatFallback workspaceId={workspaceId} onClose={onClose} failed />}
    >
      <Suspense fallback={<QuickChatFallback workspaceId={workspaceId} onClose={onClose} />}>
        <QuickChatSheet workspaceId={workspaceId} onClose={onClose} />
      </Suspense>
    </ErrorBoundary>
  );
}
