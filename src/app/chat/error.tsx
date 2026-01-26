'use client';

import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useEffect } from 'react';

import { Button } from '@/components/ui/button';

interface ChatErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

/**
 * Error boundary for the chat page.
 * Catches rendering errors and provides a recovery option.
 */
export default function ChatError({ error, reset }: ChatErrorProps) {
  useEffect(() => {
    // Log the error for debugging/monitoring - intentional for production error tracking
    // biome-ignore lint/suspicious/noConsole: Error logging is intentional for debugging
    console.error('Chat error:', error);
  }, [error]);

  return (
    <div className="flex h-full flex-col items-center justify-center p-8">
      <div className="flex flex-col items-center gap-4 text-center max-w-md">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10">
          <AlertTriangle className="h-8 w-8 text-destructive" />
        </div>
        <div className="space-y-2">
          <h2 className="text-xl font-semibold">Something went wrong</h2>
          <p className="text-sm text-muted-foreground">
            An error occurred while rendering the chat. This might be due to a malformed message or
            a temporary issue.
          </p>
          {process.env.NODE_ENV === 'development' && (
            <p className="mt-2 text-xs font-mono text-destructive bg-destructive/10 p-2 rounded">
              {error.message}
            </p>
          )}
        </div>
        <Button onClick={reset} className="gap-2">
          <RefreshCw className="h-4 w-4" />
          Try Again
        </Button>
      </div>
    </div>
  );
}
