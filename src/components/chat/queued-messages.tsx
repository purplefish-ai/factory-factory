'use client';

import { Clock, Loader2, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { QueuedMessage } from '@/lib/claude-types';

interface QueuedMessagesProps {
  messages: QueuedMessage[];
  removingIds: Set<string>;
  onRemove: (id: string) => void;
}

/**
 * Displays the queue of pending messages waiting to be sent to the agent.
 * Each message can be removed before it is sent.
 */
export function QueuedMessages({ messages, removingIds, onRemove }: QueuedMessagesProps) {
  if (messages.length === 0) {
    return null;
  }

  return (
    <div className="border-t border-dashed px-4 py-2 bg-muted/30">
      <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
        <Clock className="h-3 w-3" />
        <span>Queued ({messages.length})</span>
      </div>
      <div className="space-y-1">
        {messages.map((msg) => {
          const isRemoving = removingIds.has(msg.id);
          return (
            <div
              key={msg.id}
              className={`flex items-start gap-2 py-1 group ${isRemoving ? 'opacity-50' : ''}`}
            >
              <div className="flex-1 text-sm truncate text-muted-foreground" title={msg.text}>
                {msg.text}
              </div>
              {isRemoving ? (
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              ) : (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5 opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={() => onRemove(msg.id)}
                  aria-label="Remove queued message"
                >
                  <X className="h-3 w-3" />
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
