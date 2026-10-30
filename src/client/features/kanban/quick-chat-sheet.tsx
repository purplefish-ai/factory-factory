import { SpinnerGapIcon } from '@phosphor-icons/react/dist/csr/SpinnerGap';
import { useMemo } from 'react';
import { type SessionData, SessionTabBar } from '@/client/features/chat';
import { QuickActionsMenu } from '@/client/features/workspace';
import { trpc } from '@/client/lib/trpc';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
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

  const explicitWorkspaceProvider =
    workspace?.defaultSessionProvider === 'CODEX' || workspace?.defaultSessionProvider === 'CLAUDE'
      ? workspace.defaultSessionProvider
      : undefined;
  const settings = trpc.userSettings.get.useQuery(undefined, {
    enabled: !!workspaceId && !explicitWorkspaceProvider,
    staleTime: 30_000,
  });
  const workspaceProvider = explicitWorkspaceProvider ?? settings.data?.defaultSessionProvider;

  const {
    sessions,
    selectedSessionId,
    selectedCodexAccountId,
    setSelectedSessionId,
    chatState,
    transcriptScroll,
    handleNewChat,
    handleCloseSession,
    handleQuickAction,
    isCreatingSession,
    sessionsLoaded,
  } = useQuickChat(workspaceId, workspaceProvider);

  const sessionTabData: SessionData[] = useMemo(
    () =>
      sessions.map((s) => ({
        id: s.id,
        status: s.status,
        name: s.name ?? null,
        workflow: s.workflow,
        provider: s.provider,
        createdAt: new Date(s.createdAt),
      })),
    [sessions]
  );

  const runningSessionId = useMemo(() => sessions.find((s) => s.isWorking)?.id ?? null, [sessions]);

  // There are no tabs until sessions load, and new chats need the list for their defaults.
  const tabBarDisabled = isCreatingSession || !workspaceId || !sessionsLoaded;

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
              workspaceProvider={workspaceProvider}
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
              codexAccountId={selectedCodexAccountId}
              chatState={chatState}
              transcriptScroll={transcriptScroll}
            />
          ) : workspaceId ? (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              <SpinnerGapIcon className="h-5 w-5 animate-spin mr-2" />
              Loading sessions...
            </div>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
