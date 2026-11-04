import { useRef } from 'react';
import type { ChatMessage, GroupedMessageItem } from '@/lib/chat-protocol';
import {
  createIncrementalChatGrouper,
  type IncrementalChatGrouper,
  type IncrementalChatGroupingOptions,
} from './incremental-chat-grouping';

export function useGroupedChatMessages(
  messages: ChatMessage[],
  options: IncrementalChatGroupingOptions = {}
): GroupedMessageItem[] {
  const filterDuplicateResults = options.filterDuplicateResults ?? false;
  const cacheRef = useRef<{
    filterDuplicateResults: boolean;
    groupBoundaries?: ReadonlySet<string>;
    grouper: IncrementalChatGrouper;
  } | null>(null);
  if (
    !cacheRef.current ||
    cacheRef.current.filterDuplicateResults !== filterDuplicateResults ||
    cacheRef.current.groupBoundaries !== options.groupBoundaries
  ) {
    cacheRef.current = {
      filterDuplicateResults,
      groupBoundaries: options.groupBoundaries,
      grouper: createIncrementalChatGrouper({
        filterDuplicateResults,
        groupBoundaries: options.groupBoundaries,
      }),
    };
  }
  return cacheRef.current.grouper.group(messages);
}
