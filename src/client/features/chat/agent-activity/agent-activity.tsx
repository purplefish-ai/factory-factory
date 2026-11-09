import { SteeringWheelIcon } from '@phosphor-icons/react/dist/csr/SteeringWheel';
import { XIcon } from '@phosphor-icons/react/dist/csr/X';
import { memo } from 'react';
import { AttachmentPreview } from '@/client/features/composer';
import type { ChatMessage, GroupedMessageItem } from '@/lib/chat-protocol';
import { isToolSequence } from '@/lib/chat-protocol';
import { cn } from '@/lib/utils';
import { AssistantMessageRenderer, MessageWrapper } from './message-renderers';
import { InboxNotificationRenderer } from './message-renderers/inbox-notification-renderer';
import { PRUpdateRenderer } from './message-renderers/pr-update-renderer';
import {
  isSubagentLifecycleMessage,
  SubagentLifecycleRenderer,
} from './message-renderers/subagent-lifecycle-renderer';
import { getInboxNotification } from './message-renderers/workspace-inbox-notification';
import { ToolSequenceGroup } from './tool-renderers';
import {
  createToolCallExpansionKey,
  createToolSequenceExpansionKey,
} from './tool-renderers/tool-expansion-state';

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Gets message text for display, handling undefined values.
 */
function getMessageText(text: string | undefined): string {
  return text ?? '';
}

function isPRUpdateMessage(message: ChatMessage): boolean {
  return message.message?.type === 'pr_update' || message.id.startsWith('pr-event-');
}

// =============================================================================
// Message Item
// =============================================================================

export interface MessageItemProps {
  message: ChatMessage;
  /** Whether this message is still queued (not yet dispatched to agent) */
  isQueued?: boolean;
  /** Callback to cancel/remove this queued message */
  onRemove?: () => void;
  onSteer?: () => void;
  resolveWorkspaceFileLink?: (href: string) => string | null;
  onWorkspaceFileLink?: (path: string) => void;
  onOpenSubagent?: (subagentId: string) => void;
}

function PRUpdateMessageItem({
  message,
  isQueued,
}: Pick<MessageItemProps, 'message' | 'isQueued'>) {
  if (message.message?.prDeliveryState === 'cancelled') {
    return null;
  }
  return (
    <MessageWrapper>
      <PRUpdateRenderer
        text={message.message?.text ?? message.text ?? 'PR update'}
        queued={isQueued}
        deliveryState={message.message?.prDeliveryState}
        error={message.message?.error}
      />
    </MessageWrapper>
  );
}

function QueuedMessageSteerAction({ onSteer }: { onSteer: () => void }) {
  return (
    <button
      onClick={onSteer}
      className={cn(
        'inline-flex h-6 items-center justify-center gap-1 rounded-md px-1.5 text-xs font-medium',
        'bg-background/90 text-primary hover:bg-primary/10',
        'border border-primary/30 hover:border-primary/60 shadow-sm',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
      )}
      title="Send into the active turn now. The agent may redirect its current work."
      type="button"
      aria-label="Steer queued message"
    >
      <SteeringWheelIcon className="h-3.5 w-3.5" />
      Steer
    </button>
  );
}

function QueuedMessageActions({
  message,
  isQueued,
  onRemove,
  onSteer,
}: Pick<MessageItemProps, 'message' | 'isQueued' | 'onRemove' | 'onSteer'>) {
  const steer =
    isQueued &&
    onSteer &&
    !message.id.startsWith('workspace-notification-') &&
    !message.text?.trimStart().startsWith('/')
      ? onSteer
      : undefined;
  const hasQueuedActions = isQueued && Boolean(steer || onRemove);
  // Keep the row mounted with a stable inner height while it collapses.
  return (
    <div
      className="grid transition-[grid-template-rows,opacity] duration-150 ease-out motion-reduce:transition-none"
      style={{
        gridTemplateRows: hasQueuedActions ? '1fr' : '0fr',
        opacity: hasQueuedActions ? 1 : 0,
      }}
      inert={!hasQueuedActions}
    >
      <div className="min-h-0 overflow-hidden">
        <div className="flex h-[max(2.25rem,calc(var(--touch-target-size,0px)+4px))] items-center justify-end gap-1 mb-1 px-0.5">
          {steer && <QueuedMessageSteerAction onSteer={steer} />}
          {/* Cancel button for queued messages */}
          {isQueued && onRemove && (
            <button
              onClick={onRemove}
              className={cn(
                'inline-flex size-6 items-center justify-center rounded-md',
                'bg-background/90 hover:bg-destructive/10',
                'border border-border hover:border-destructive/50',
                'shadow-sm',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
              )}
              title="Cancel queued message"
              type="button"
              aria-label="Cancel queued message"
            >
              <XIcon className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export const MessageItem = memo(function MessageItem({
  message,
  isQueued,
  onRemove,
  onSteer,
  resolveWorkspaceFileLink,
  onWorkspaceFileLink,
  onOpenSubagent,
}: MessageItemProps) {
  if (isSubagentLifecycleMessage(message.message)) {
    return <SubagentLifecycleRenderer message={message} onOpenSubagent={onOpenSubagent} />;
  }
  if (isPRUpdateMessage(message)) {
    return <PRUpdateMessageItem message={message} isQueued={isQueued} />;
  }
  const inboxNotification = getInboxNotification(message);
  if (inboxNotification) {
    return (
      <MessageWrapper>
        <InboxNotificationRenderer notification={inboxNotification} queued={isQueued} />
      </MessageWrapper>
    );
  }
  // User messages
  if (message.source === 'user') {
    const userText = getMessageText(message.text);
    return (
      <MessageWrapper>
        {/* Keep queued actions readable outside the faded message content. */}
        <div className="group relative w-full max-w-full">
          <QueuedMessageActions
            message={message}
            isQueued={isQueued}
            onRemove={onRemove}
            onSteer={onSteer}
          />
          {/* Message content - opacity applied here to fade queued messages without affecting buttons */}
          <div
            className={cn(
              'space-y-2 transition-opacity duration-150 motion-reduce:transition-none',
              isQueued && 'opacity-50'
            )}
          >
            {/* Attachments */}
            {message.attachments && message.attachments.length > 0 && (
              <AttachmentPreview attachments={message.attachments} readOnly />
            )}
            {/* Text */}
            {message.text && (
              <div className="relative w-full max-w-full">
                <div className="w-full rounded border border-border/70 bg-muted/35 px-3 py-2 break-words text-sm text-left whitespace-pre-wrap">
                  {userText}
                </div>
              </div>
            )}
          </div>
        </div>
      </MessageWrapper>
    );
  }

  // Claude messages
  if (message.message) {
    return (
      <MessageWrapper>
        <AssistantMessageRenderer
          message={message.message}
          messageId={message.id}
          resolveWorkspaceFileLink={resolveWorkspaceFileLink}
          onWorkspaceFileLink={onWorkspaceFileLink}
        />
      </MessageWrapper>
    );
  }

  return null;
});

// =============================================================================
// Grouped Message Item Renderer
// =============================================================================

export interface GroupedMessageItemRendererProps {
  item: GroupedMessageItem;
  /** Whether this message is still queued (not yet dispatched to agent) */
  isQueued?: boolean;
  /** Callback to cancel/remove this queued message */
  onRemove?: () => void;
  onSteer?: () => void;
  resolveWorkspaceFileLink?: (href: string) => string | null;
  onWorkspaceFileLink?: (path: string) => void;
  onOpenSubagent?: (subagentId: string) => void;
  /** Reads persisted expansion state by key */
  getToolExpansionState?: (key: string, defaultOpen: boolean) => boolean;
  /** Persists expansion state by key */
  setToolExpansionState?: (key: string, open: boolean) => void;
  /** Per-row token used to force rerender when this row's expansion state changes */
  toolExpansionToken?: string;
}

/**
 * Renders either a regular message or a tool sequence group.
 */
export const GroupedMessageItemRenderer = memo(function GroupedMessageItemRenderer({
  item,
  isQueued,
  onRemove,
  onSteer,
  resolveWorkspaceFileLink,
  onWorkspaceFileLink,
  onOpenSubagent,
  getToolExpansionState,
  setToolExpansionState,
  toolExpansionToken: _toolExpansionToken,
}: GroupedMessageItemRendererProps) {
  if (isToolSequence(item)) {
    const sequenceDefaultOpen = false;
    const sequenceExpansionKey = createToolSequenceExpansionKey(item.id);
    const sequenceOpen = getToolExpansionState?.(sequenceExpansionKey, sequenceDefaultOpen);
    const handleSequenceOpenChange =
      sequenceOpen !== undefined && setToolExpansionState
        ? (open: boolean) => setToolExpansionState(sequenceExpansionKey, open)
        : undefined;
    const getCallOpen = getToolExpansionState
      ? (callId: string, defaultOpen: boolean) =>
          getToolExpansionState(createToolCallExpansionKey(item.id, callId), defaultOpen)
      : undefined;
    const handleCallOpenChange = setToolExpansionState
      ? (callId: string, open: boolean) =>
          setToolExpansionState(createToolCallExpansionKey(item.id, callId), open)
      : undefined;

    return (
      <ToolSequenceGroup
        sequence={item}
        summaryOrder="latest-first"
        defaultOpen={sequenceDefaultOpen}
        open={sequenceOpen}
        onOpenChange={handleSequenceOpenChange}
        getCallOpen={getCallOpen}
        onCallOpenChange={handleCallOpenChange}
      />
    );
  }
  return (
    <MessageItem
      message={item}
      onOpenSubagent={onOpenSubagent}
      isQueued={isQueued}
      onRemove={onRemove}
      onSteer={onSteer}
      resolveWorkspaceFileLink={resolveWorkspaceFileLink}
      onWorkspaceFileLink={onWorkspaceFileLink}
    />
  );
});
