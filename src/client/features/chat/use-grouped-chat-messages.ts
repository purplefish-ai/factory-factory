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
    grouper: IncrementalChatGrouper;
  } | null>(null);
  if (!cacheRef.current || cacheRef.current.filterDuplicateResults !== filterDuplicateResults) {
    cacheRef.current = {
      filterDuplicateResults,
      grouper: createIncrementalChatGrouper({ filterDuplicateResults }),
    };
  }
  return cacheRef.current.grouper.group(messages);
}
