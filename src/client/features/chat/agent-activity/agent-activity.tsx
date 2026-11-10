import { SteeringWheelIcon } from '@phosphor-icons/react/dist/csr/SteeringWheel';
import { XIcon } from '@phosphor-icons/react/dist/csr/X';
import { memo } from 'react';
import { IconButton } from '@/client/components/icon-button';
import { ErrorBoundary } from '@/client/error-boundary';
import { AttachmentPreview } from '@/client/features/composer';
import { Button } from '@/components/ui/button';
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
  isSteering?: boolean;
  steerDisabled?: boolean;
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

function QueuedMessageSteerAction({
  onSteer,
  isSteering,
  steerDisabled,
}: {
  onSteer: () => void;
  isSteering?: boolean;
  steerDisabled?: boolean;
}) {
  return (
    <Button
      variant="outline"
      size="xs"
      onClick={onSteer}
      pending={isSteering}
      pendingLabel="Steering…"
      disabled={steerDisabled}
      className="border-primary/30 bg-background/90 text-primary shadow-sm hover:border-primary/60 hover:bg-primary/10 hover:text-primary dark:border-primary/30 dark:bg-background/90"
      title="Send into the active turn now. The agent may redirect its current work."
      aria-label={isSteering ? 'Steering queued message' : 'Steer queued message'}
    >
      <SteeringWheelIcon />
      Steer
    </Button>
  );
}

function QueuedMessageActions({
  message,
  isQueued,
  onRemove,
  onSteer,
  isSteering,
  steerDisabled,
}: Pick<
  MessageItemProps,
  'message' | 'isQueued' | 'onRemove' | 'onSteer' | 'isSteering' | 'steerDisabled'
>) {
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
          {steer && (
            <QueuedMessageSteerAction
              onSteer={steer}
              isSteering={isSteering}
              steerDisabled={steerDisabled}
            />
          )}
          {/* Cancel button for queued messages */}
          {isQueued && onRemove && (
            <IconButton
              label="Cancel queued message"
              size="icon-xs"
              variant="outline"
              onClick={onRemove}
              className="bg-background/90 text-muted-foreground shadow-sm hover:border-destructive/50 hover:bg-destructive/10 hover:text-destructive dark:bg-background/90"
            >
              <XIcon />
            </IconButton>
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
  isSteering,
  steerDisabled,
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
            isSteering={isSteering}
            steerDisabled={steerDisabled}
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
  isSteering?: boolean;
  steerDisabled?: boolean;
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
 * Renders either a regular message or a tool sequence group. A row that fails
 * to render shows a compact error in its place; replaying the same transcript
 * would otherwise crash the whole page again. The boundary retries when the
 * row's item changes, e.g. as a streamed message grows.
 */
export const GroupedMessageItemRenderer = memo(function GroupedMessageItemRenderer(
  props: GroupedMessageItemRendererProps
) {
  return (
    <ErrorBoundary
      variant="compact"
      title="Couldn't render this message"
      resetKey={props.item}
      className="h-auto py-3"
    >
      <GroupedMessageItemContent {...props} />
    </ErrorBoundary>
  );
});

function GroupedMessageItemContent({
  item,
  isQueued,
  onRemove,
  onSteer,
  isSteering,
  steerDisabled,
  resolveWorkspaceFileLink,
  onWorkspaceFileLink,
  onOpenSubagent,
  getToolExpansionState,
  setToolExpansionState,
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
      isSteering={isSteering}
      steerDisabled={steerDisabled}
      resolveWorkspaceFileLink={resolveWorkspaceFileLink}
      onWorkspaceFileLink={onWorkspaceFileLink}
    />
  );
}
