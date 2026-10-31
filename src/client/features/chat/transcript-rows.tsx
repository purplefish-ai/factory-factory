import type { Virtualizer } from '@tanstack/react-virtual';
import type { ReactNode } from 'react';
import { type GroupedMessageItem, isToolSequence } from '@/lib/chat-protocol';
import { GroupedMessageItemRenderer } from './agent-activity';
import { ThinkingCompletionProvider } from './agent-activity/message-renderers';
import {
  createToolCallExpansionKey,
  createToolSequenceExpansionKey,
  useWorkspaceToolExpansionState,
} from './agent-activity/tool-renderers/tool-expansion-state';
import type { TranscriptDisplayProps } from './transcript-display.types';
import { type TranscriptLayout, TranscriptTail } from './transcript-layout';

interface Props {
  display: TranscriptDisplayProps;
  layout: TranscriptLayout;
  engine: Virtualizer<HTMLDivElement, HTMLDivElement>;
  totalSize: number;
  header?: ReactNode;
  contentClassName?: string;
}

function TranscriptMessage({
  item,
  display,
  getExpansionState,
  setExpansionState,
}: { item: GroupedMessageItem; display: TranscriptDisplayProps } & ReturnType<
  typeof useWorkspaceToolExpansionState
>) {
  const queued = display.queuedMessageIds?.has(item.id) ?? false;
  return (
    <GroupedMessageItemRenderer
      item={item}
      onOpenAgents={display.onOpenAgents}
      isQueued={queued}
      toolExpansionToken={
        display.workspaceId && isToolSequence(item)
          ? [
              getExpansionState(createToolSequenceExpansionKey(item.id), false),
              ...item.pairedCalls.map((call) =>
                getExpansionState(createToolCallExpansionKey(item.id, call.id), false)
              ),
            ].join(':')
          : undefined
      }
      onSteer={
        queued && display.onSteerQueuedMessage
          ? () => display.onSteerQueuedMessage?.(item.id)
          : undefined
      }
      onRemove={
        queued && display.onRemoveQueuedMessage
          ? () => display.onRemoveQueuedMessage?.(item.id)
          : undefined
      }
      userMessageUuid={
        'source' in item && item.source === 'user'
          ? display.getUuidForMessageId?.(item.id)
          : undefined
      }
      onRewindToMessage={display.onRewindToMessage}
      resolveWorkspaceFileLink={display.resolveWorkspaceFileLink}
      onWorkspaceFileLink={display.onWorkspaceFileLink}
      getToolExpansionState={display.workspaceId ? getExpansionState : undefined}
      setToolExpansionState={display.workspaceId ? setExpansionState : undefined}
    />
  );
}

/** Rendering only. The measured row includes its tail, so there is one extent. */
export function TranscriptRows({
  display,
  layout,
  engine,
  totalSize,
  header,
  contentClassName,
}: Props) {
  const { getExpansionState, setExpansionState } = useWorkspaceToolExpansionState(
    display.workspaceId
  );
  const tail = (
    <TranscriptTail
      props={display}
      queuedPRUpdate={layout.queuedPRUpdate}
      hasVisibleMessages={layout.messages.length > 0 || !!layout.queuedPRUpdate}
    />
  );
  const content = (index: number) => {
    if (layout.headerOffset && index === 0) {
      return header;
    }
    const messageIndex = index - layout.headerOffset;
    const item = layout.messages[messageIndex];
    if (!item) {
      return tail;
    }
    return (
      <>
        <TranscriptMessage
          item={item}
          display={display}
          getExpansionState={getExpansionState}
          setExpansionState={setExpansionState}
        />
        {messageIndex === layout.messages.length - 1 && tail}
      </>
    );
  };
  return (
    <ThinkingCompletionProvider
      lastThinkingMessageId={layout.lastThinkingMessageId}
      running={display.running}
    >
      {display.loadingSession ? (
        <div className="px-4 py-4">
          {layout.keys.map((key, index) => (
            <div key={key} className={contentClassName}>
              {content(index)}
            </div>
          ))}
        </div>
      ) : (
        <div style={{ height: totalSize, position: 'relative', width: '100%' }}>
          {engine.getVirtualItems().map((row) => {
            const item = layout.messages[row.index - layout.headerOffset];
            return (
              <div
                key={row.key}
                ref={engine.measureElement}
                data-index={row.index}
                data-transcript-key={row.key}
                data-tool-sequence={item && isToolSequence(item) ? 'true' : undefined}
                className="px-4 min-w-0"
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${row.start}px)`,
                }}
              >
                <div className={contentClassName}>{content(row.index)}</div>
              </div>
            );
          })}
        </div>
      )}
    </ThinkingCompletionProvider>
  );
}
