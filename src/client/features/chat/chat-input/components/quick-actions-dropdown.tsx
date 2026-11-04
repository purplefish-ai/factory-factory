import { CameraIcon } from '@phosphor-icons/react/dist/csr/Camera';
import { ChatTextIcon } from '@phosphor-icons/react/dist/csr/ChatText';
import { CheckIcon } from '@phosphor-icons/react/dist/csr/Check';
import { EyeIcon } from '@phosphor-icons/react/dist/csr/Eye';
import { GitBranchIcon } from '@phosphor-icons/react/dist/csr/GitBranch';
import { GitPullRequestIcon } from '@phosphor-icons/react/dist/csr/GitPullRequest';
import { LightningIcon } from '@phosphor-icons/react/dist/csr/Lightning';
import { PlayIcon } from '@phosphor-icons/react/dist/csr/Play';
import { SparkleIcon } from '@phosphor-icons/react/dist/csr/Sparkle';
import { TerminalIcon } from '@phosphor-icons/react/dist/csr/Terminal';
import type { Icon } from '@phosphor-icons/react/dist/lib/types';
import { useState } from 'react';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

/** An agent quick action from `prompts/quick-actions/` (`session.listQuickActions`). */
export interface QuickActionOption {
  id: string;
  name: string;
  description: string;
  icon?: string | null;
  /** The prompt; script actions have none and are not offered. */
  content?: string | null;
}

export type QuickActionTarget = 'this-chat' | 'new-chat';

export interface QuickActionsDropdownProps {
  /** Sends the action's prompt into the chat this composer belongs to. */
  onRunInThisChat: (prompt: string) => void;
  /** Starts a new chat named after the action. Omit where only this chat applies. */
  onRunInNewChat?: (name: string, prompt: string) => void;
  /** Why a new chat can't start right now, such as the per-workspace chat limit. */
  newChatUnavailableReason?: string | null;
  /** This chat can't take a prompt (disconnected or starting). */
  thisChatDisabled?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  shortcut?: string;
  showShortcut?: boolean;
}

const ICON_MAP: Record<string, Icon> = {
  zap: LightningIcon,
  sparkles: SparkleIcon,
  eye: EyeIcon,
  play: PlayIcon,
  terminal: TerminalIcon,
  check: CheckIcon,
  camera: CameraIcon,
  'git-branch': GitBranchIcon,
  'git-pull-request': GitPullRequestIcon,
  'chat-text': ChatTextIcon,
};

function getActionIcon(iconName?: string | null): Icon {
  return (iconName && ICON_MAP[iconName]) || LightningIcon;
}

/**
 * Falls back to the other target when the chosen one is unavailable, so the
 * menu always runs actions somewhere that can take them.
 */
export function resolveQuickActionTarget(
  chosen: QuickActionTarget,
  { thisChat, newChat }: { thisChat: boolean; newChat: boolean }
): QuickActionTarget {
  if (chosen === 'this-chat' && !thisChat && newChat) {
    return 'new-chat';
  }
  if (chosen === 'new-chat' && !newChat) {
    return 'this-chat';
  }
  return chosen;
}

/**
 * The composer's ⚡ menu: the one place to run a quick action, either in this
 * chat or in a new one. Actions come from `prompts/quick-actions/`.
 */
export function QuickActionsDropdown(props: QuickActionsDropdownProps) {
  const query = trpc.session.listQuickActions.useQuery(undefined, { staleTime: Infinity });
  const actions = query.data?.filter((action) => action.type === 'agent' && action.content);
  return (
    <QuickActionsDropdownView
      {...props}
      actions={actions}
      status={query.isError ? 'error' : query.isPending ? 'loading' : 'ready'}
      onRetry={() => void query.refetch()}
    />
  );
}

export function QuickActionsDropdownView({
  actions = [],
  status,
  onRetry,
  onRunInThisChat,
  onRunInNewChat,
  newChatUnavailableReason,
  thisChatDisabled = false,
  open,
  onOpenChange,
  shortcut,
  showShortcut = false,
}: QuickActionsDropdownProps & {
  actions?: readonly QuickActionOption[];
  status: 'loading' | 'error' | 'ready';
  onRetry?: () => void;
}) {
  const [chosenTarget, setChosenTarget] = useState<QuickActionTarget | null>(null);
  const offersNewChat = onRunInNewChat !== undefined;
  const available = {
    thisChat: !thisChatDisabled,
    newChat: offersNewChat && !newChatUnavailableReason,
  };
  const target = chosenTarget ?? resolveQuickActionTarget('this-chat', available);
  const targetAvailable = target === 'this-chat' ? available.thisChat : available.newChat;
  const shortcutText = showShortcut && shortcut ? ` (${shortcut})` : '';

  const run = (action: QuickActionOption) => {
    if (!action.content || !targetAvailable) {
      return;
    }
    if (target === 'new-chat') {
      onRunInNewChat?.(action.name, action.content);
    } else {
      onRunInThisChat(action.content);
    }
  };

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                disabled={!(available.thisChat || available.newChat)}
                className="h-6 w-6 p-0"
                aria-label="Quick actions"
              >
                <LightningIcon className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p>Quick actions{shortcutText}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <DropdownMenuContent align="start" className="w-72 max-w-[calc(100vw-1rem)]">
        <DropdownMenuLabel>Quick actions</DropdownMenuLabel>
        {offersNewChat && (
          <>
            <DropdownMenuRadioGroup
              value={target}
              onValueChange={(value) => {
                if (value === 'this-chat' || value === 'new-chat') {
                  setChosenTarget(value);
                }
              }}
            >
              <DropdownMenuRadioItem
                value="this-chat"
                disabled={!available.thisChat}
                onSelect={(event) => event.preventDefault()}
              >
                Run in this chat
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem
                value="new-chat"
                disabled={!available.newChat}
                onSelect={(event) => event.preventDefault()}
              >
                Run in new chat
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            {newChatUnavailableReason && (
              <p className="px-2 pb-1 text-xs text-muted-foreground">{newChatUnavailableReason}</p>
            )}
            <DropdownMenuSeparator />
          </>
        )}
        <QuickActionItems
          actions={actions}
          status={status}
          onRetry={onRetry}
          onRun={run}
          disabled={!targetAvailable}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function QuickActionItems({
  disabled,
  actions,
  status,
  onRetry,
  onRun,
}: {
  disabled: boolean;
  actions: readonly QuickActionOption[];
  status: 'loading' | 'error' | 'ready';
  onRetry?: () => void;
  onRun: (action: QuickActionOption) => void;
}) {
  if (status === 'loading') {
    return <DropdownMenuItem disabled>Loading quick actions…</DropdownMenuItem>;
  }
  if (status === 'error') {
    return (
      <>
        <p className="px-2 py-1.5 text-xs text-muted-foreground">Couldn't load quick actions.</p>
        {onRetry && (
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              onRetry();
            }}
          >
            Retry
          </DropdownMenuItem>
        )}
      </>
    );
  }
  if (actions.length === 0) {
    return <p className="px-2 py-1.5 text-xs text-muted-foreground">No quick actions</p>;
  }
  return actions.map((action) => {
    const ActionIcon = getActionIcon(action.icon);
    return (
      <DropdownMenuItem
        key={action.id}
        disabled={disabled}
        onSelect={() => onRun(action)}
        className="items-start"
      >
        <ActionIcon className="mt-0.5 h-4 w-4" />
        <span className="flex min-w-0 flex-col">
          <span>{action.name}</span>
          {action.description && (
            <span className="text-xs text-muted-foreground">{action.description}</span>
          )}
        </span>
      </DropdownMenuItem>
    );
  });
}
