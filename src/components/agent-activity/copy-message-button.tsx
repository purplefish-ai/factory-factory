import { Check, Copy } from 'lucide-react';
import * as React from 'react';
import { cn } from '@/lib/utils';

const COPY_SUCCESS_DURATION_MS = 2000;

// =============================================================================
// Copy Message Button
// =============================================================================

interface CopyMessageButtonProps {
  /** The text content to copy to clipboard */
  textContent: string;
  /** Optional className for styling */
  className?: string;
}

/**
 * A copy-to-clipboard button that appears on hover of the parent message.
 * Shows a checkmark briefly after successful copy.
 */
export function CopyMessageButton({ textContent, className }: CopyMessageButtonProps) {
  const [isCopied, setIsCopied] = React.useState(false);
  const timeoutRef = React.useRef<number | undefined>(undefined);

  // Cleanup timeout on unmount
  React.useEffect(() => {
    return () => {
      if (timeoutRef.current !== undefined) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(textContent);
      setIsCopied(true);

      // Clear any existing timeout
      if (timeoutRef.current !== undefined) {
        clearTimeout(timeoutRef.current);
      }

      // Reset copied state after delay
      timeoutRef.current = window.setTimeout(() => {
        setIsCopied(false);
      }, COPY_SUCCESS_DURATION_MS);
    } catch {
      // Silently fail - clipboard access might be denied
    }
  };

  return (
    <button
      onClick={handleCopy}
      onMouseDown={(e) => e.preventDefault()}
      className={cn(
        'absolute top-1 right-1 p-1.5 rounded-md',
        'bg-background/90 hover:bg-background',
        'border border-border',
        'shadow-sm',
        'opacity-0 group-hover:opacity-100',
        'transition-all',
        'z-10',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className
      )}
      title="Copy to clipboard"
      type="button"
      aria-label="Copy message to clipboard"
    >
      {isCopied ? (
        <Check className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />
      ) : (
        <Copy className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
      )}
    </button>
  );
}
