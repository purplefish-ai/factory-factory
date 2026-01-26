'use client';

import { Loader2, Send } from 'lucide-react';
import { type KeyboardEvent, useCallback, useEffect } from 'react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

// =============================================================================
// Types
// =============================================================================

interface ChatInputProps {
  onSend: (text: string) => void;
  disabled?: boolean;
  running?: boolean;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  placeholder?: string;
  className?: string;
}

// =============================================================================
// Main Component
// =============================================================================

/**
 * Chat input component with textarea and send button.
 * Supports Enter to send and Shift+Enter for new line.
 */
export function ChatInput({
  onSend,
  disabled = false,
  running = false,
  inputRef,
  placeholder = 'Type a message...',
  className,
}: ChatInputProps) {
  // Handle key press for Enter to send
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter without Shift sends the message
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        const text = event.currentTarget.value.trim();
        if (text && !disabled) {
          onSend(text);
          event.currentTarget.value = '';
          // Reset textarea height
          event.currentTarget.style.height = 'auto';
        }
      }
    },
    [onSend, disabled]
  );

  // Handle send button click
  const handleSendClick = useCallback(() => {
    if (inputRef?.current) {
      const text = inputRef.current.value.trim();
      if (text && !disabled) {
        onSend(text);
        inputRef.current.value = '';
        inputRef.current.style.height = 'auto';
        inputRef.current.focus();
      }
    }
  }, [onSend, inputRef, disabled]);

  // Auto-resize textarea based on content
  const handleInput = useCallback((event: React.FormEvent<HTMLTextAreaElement>) => {
    const target = event.currentTarget;
    target.style.height = 'auto';
    target.style.height = `${Math.min(target.scrollHeight, 200)}px`;
  }, []);

  // Focus input when component mounts or when running state changes to false
  useEffect(() => {
    if (!(running || disabled) && inputRef?.current) {
      inputRef.current.focus();
    }
  }, [running, disabled, inputRef]);

  const isDisabled = disabled || !inputRef;

  return (
    <div className={cn('flex gap-2 p-4 border-t bg-background', className)}>
      <Textarea
        ref={inputRef}
        onKeyDown={handleKeyDown}
        onInput={handleInput}
        disabled={isDisabled}
        placeholder={isDisabled ? 'Connecting...' : placeholder}
        className={cn(
          'min-h-[40px] max-h-[200px] resize-none',
          isDisabled && 'opacity-50 cursor-not-allowed'
        )}
        rows={1}
      />
      <Button
        onClick={handleSendClick}
        disabled={isDisabled}
        size="icon"
        className="shrink-0"
        aria-label="Send message"
      >
        {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
      </Button>
    </div>
  );
}
