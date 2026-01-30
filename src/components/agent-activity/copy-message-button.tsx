'use client';

import { Check, Copy } from 'lucide-react';
import * as React from 'react';
import { cn } from '@/lib/utils';

interface CopyMessageButtonProps {
  /** The text content to copy to clipboard */
  textContent: string;
  /** Optional className for styling */
  className?: string;
}

/**
 * A copy-to-clipboard button that appears when Ctrl is pressed.
 * Shows a checkmark briefly after successful copy.
 */
export function CopyMessageButton({ textContent, className }: CopyMessageButtonProps) {
  const [isCtrlPressed, setIsCtrlPressed] = React.useState(false);
  const [isCopied, setIsCopied] = React.useState(false);

  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Control' || e.key === 'Meta') {
        setIsCtrlPressed(true);
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Control' || e.key === 'Meta') {
        setIsCtrlPressed(false);
      }
    };

    // Handle blur to reset state when window loses focus
    const handleBlur = () => {
      setIsCtrlPressed(false);
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, []);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(textContent);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    } catch {
      // Silently fail - clipboard access might be denied
    }
  };

  if (!isCtrlPressed) {
    return null;
  }

  return (
    <button
      onClick={handleCopy}
      className={cn(
        'absolute top-1 right-1 p-1.5 rounded-md',
        'bg-background/90 hover:bg-background',
        'border border-border',
        'shadow-sm',
        'transition-colors',
        'z-10',
        className
      )}
      title="Copy to clipboard"
      type="button"
    >
      {isCopied ? (
        <Check className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />
      ) : (
        <Copy className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
      )}
    </button>
  );
}
