import { Loader2 } from 'lucide-react';
import { useMemo } from 'react';
import type { SessionData } from '@/components/chat/session-tab-bar';
import { SessionTabBar } from '@/components/chat/session-tab-bar';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { QuickActionsMenu } from '@/components/workspace/quick-actions-menu';
import { useKanban } from './kanban-context';
import { QuickChatContent } from './quick-chat-content';
import { useQuickChat } from './use-quick-chat';

interface QuickChatSheetProps {
  workspaceId: string | null;
  onClose: () => void;
}

export function QuickChatSheet({ workspaceId, onClose }: QuickChatSheetProps) {
  const { workspaces } = useKanban();
  const workspace = useMemo(
    () => workspaces?.find((w) => w.id === workspaceId) ?? null,
    [workspaces, workspaceId]
  );

  const {
    sessions,
    selectedSessionId,
    setSelectedSessionId,
    chatState,
    viewportRef,
    onScroll,
    isNearBottom,
    scrollToBottom,
    handleNewChat,
    handleCloseSession,
    handleQuickAction,
    isCreatingSession,
  } = useQuickChat(workspaceId);

  const sessionTabData: SessionData[] = useMemo(
    () =>
      sessions.map((s) => ({
        id: s.id,
        status: s.status,
        name: s.name ?? null,
        createdAt: new Date(s.createdAt),
      })),
    [sessions]
  );

  const runningSessionId = useMemo(() => sessions.find((s) => s.isWorking)?.id ?? null, [sessions]);

  const tabBarDisabled = isCreatingSession || !workspaceId;

  return (
    <Sheet open={!!workspaceId} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-2xl flex flex-col p-0">
        {/* Header */}
        <SheetHeader className="px-4 pt-4 pb-0 shrink-0">
          <SheetTitle className="text-base leading-tight pr-8 truncate">
            {workspace?.name ?? 'Quick Chat'}
          </SheetTitle>
          <SheetDescription className="sr-only">
            Chat with the agent for this workspace
          </SheetDescription>
        </SheetHeader>

        {/* Session tab bar with actions — always visible */}
        <div className="flex items-center gap-1 px-4 py-2 border-b shrink-0">
          <div className="flex-1 min-w-0">
            <SessionTabBar
              sessions={sessionTabData}
              currentSessionId={selectedSessionId}
              runningSessionId={runningSessionId}
              onSelectSession={setSelectedSessionId}
              onCreateSession={handleNewChat}
              onCloseSession={handleCloseSession}
              disabled={tabBarDisabled}
            />
          </div>
          <QuickActionsMenu
            onExecuteAgent={(action) => {
              if (action.content) {
                handleQuickAction(action.name, action.content);
              }
            }}
            disabled={tabBarDisabled}
          />
        </div>

        {/* Chat content */}
        <div className="flex-1 min-h-0">
          {workspaceId && selectedSessionId ? (
            <QuickChatContent
              workspaceId={workspaceId}
              chatState={chatState}
              viewportRef={viewportRef}
              onScroll={onScroll}
              isNearBottom={isNearBottom}
              scrollToBottom={scrollToBottom}
            />
          ) : workspaceId ? (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mr-2" />
              Loading sessions...
            </div>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
