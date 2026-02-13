import { Clock, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { QueuedMessage } from '@/lib/chat-protocol';

interface QueuedMessagesProps {
  messages: QueuedMessage[];
  onRemove: (id: string) => void;
}

/**
 * Displays the queue of pending messages waiting to be sent to the agent.
 * Each message can be removed before it is sent.
 */
export function QueuedMessages({ messages, onRemove }: QueuedMessagesProps) {
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
        {messages.map((msg) => (
          <div key={msg.id} className="flex items-start gap-2 py-1 group">
            <div className="flex-1 text-sm truncate text-muted-foreground" title={msg.text}>
              {msg.text}
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5 opacity-0 group-hover:opacity-100 transition-opacity"
              onClick={() => onRemove(msg.id)}
              aria-label="Remove queued message"
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
