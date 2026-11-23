import { lazy, type ReactNode, Suspense, useState } from 'react';
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
import { createQuickChatScrollMemory } from './use-quick-chat-scroll';

// Quick Chat renders the chat transcript and its Markdown renderer, about a megabyte
// the board itself never shows, so its body loads inside the open sheet.
const QuickChatSheetBody = lazy(() =>
  import('./quick-chat-sheet').then((module) => ({ default: module.QuickChatSheetBody }))
);

interface QuickChatSheetFrameProps {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
}

/** The sheet and its header, which open at once while the body loads. */
export function QuickChatSheetFrame({ open, title, onClose, children }: QuickChatSheetFrameProps) {
  return (
    <Sheet open={open} onOpenChange={(value) => !value && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-2xl flex flex-col p-0">
        <SheetHeader className="px-4 pt-4 pb-0 shrink-0">
          <SheetTitle className="text-base leading-tight pr-8 truncate">{title}</SheetTitle>
          <SheetDescription className="sr-only">
            Chat with the agent for this workspace
          </SheetDescription>
        </SheetHeader>
        {children}
      </SheetContent>
    </Sheet>
  );
}

/** The body's place while its chunk loads, or after it fails to load or render. */
export function QuickChatUnavailable({ failed = false }: { failed?: boolean }) {
  return (
    <div className="flex-1 min-h-0">
      {failed ? (
        <div role="alert" className="flex flex-col items-center gap-3 p-4 text-sm">
          Couldn't show Quick Chat. Reload the app to try again.
          <Button size="sm" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </div>
      ) : (
        <Loading size="compact" message="Loading chat…" />
      )}
    </div>
  );
}

function WorkspaceTitle({ workspaceId }: { workspaceId: string | null }) {
  const { workspaces } = useKanbanState();
  return workspaces?.find((workspace) => workspace.id === workspaceId)?.name ?? 'Quick Chat';
}

interface LazyQuickChatSheetProps {
  workspaceId: string | null;
  onClose: () => void;
}

export function LazyQuickChatSheet({ workspaceId, onClose }: LazyQuickChatSheetProps) {
  // The body unmounts on close; scroll positions live here so reopening restores them.
  const [scrollMemory] = useState(createQuickChatScrollMemory);
  return (
    <QuickChatSheetFrame
      open={!!workspaceId}
      title={<WorkspaceTitle workspaceId={workspaceId} />}
      onClose={onClose}
    >
      <ErrorBoundary fallback={<QuickChatUnavailable failed />}>
        <Suspense fallback={<QuickChatUnavailable />}>
          <QuickChatSheetBody workspaceId={workspaceId} scrollMemory={scrollMemory} />
        </Suspense>
      </ErrorBoundary>
    </QuickChatSheetFrame>
  );
}
