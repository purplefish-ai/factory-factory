import { useMemo } from 'react';
import type { ChatMessage, GroupedMessageItem } from '@/lib/chat-protocol';
import {
  createIncrementalChatGrouper,
  type IncrementalChatGroupingOptions,
} from './incremental-chat-grouping';

export function useGroupedChatMessages(
  messages: ChatMessage[],
  options: IncrementalChatGroupingOptions = {}
): GroupedMessageItem[] {
  const filterDuplicateResults = options.filterDuplicateResults ?? false;
  const { groupBoundaries } = options;
  // The grouper reuses its previous result, so it lives as long as its options.
  const grouper = useMemo(
    () => createIncrementalChatGrouper({ filterDuplicateResults, groupBoundaries }),
    [filterDuplicateResults, groupBoundaries]
  );
  return grouper.group(messages);
}
