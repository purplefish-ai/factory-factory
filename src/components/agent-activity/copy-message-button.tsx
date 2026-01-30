'use client';

import { Check, Copy } from 'lucide-react';
import * as React from 'react';
import { cn } from '@/lib/utils';

const COPY_SUCCESS_DURATION_MS = 2000;

// =============================================================================
// Keyboard State Context
// =============================================================================

/**
 * Shared context for tracking Ctrl/Cmd key state.
 * This prevents multiple event listeners when there are many copy buttons.
 */
const KeyboardStateContext = React.createContext<{
  isCtrlPressed: boolean;
}>({ isCtrlPressed: false });

/**
 * Provider that manages global keyboard state for all copy buttons.
 */
export function KeyboardStateProvider({ children }: { children: React.ReactNode }) {
  const [isCtrlPressed, setIsCtrlPressed] = React.useState(false);

  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Meta key (Command on Mac), Control key (Ctrl on Windows/Linux)
      if (e.key === 'Control' || e.key === 'Meta' || e.metaKey || e.ctrlKey) {
        setIsCtrlPressed(true);
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      // Only reset if Control or Meta key was released
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

  return (
    <KeyboardStateContext.Provider value={{ isCtrlPressed }}>
      {children}
    </KeyboardStateContext.Provider>
  );
}

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
 * A copy-to-clipboard button that appears when Ctrl/Cmd is pressed.
 * Shows a checkmark briefly after successful copy.
 */
export function CopyMessageButton({ textContent, className }: CopyMessageButtonProps) {
  const { isCtrlPressed } = React.useContext(KeyboardStateContext);
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

  if (!isCtrlPressed) {
    return null;
  }

  return (
    <button
      onClick={handleCopy}
      onMouseDown={(e) => e.preventDefault()}
      className={cn(
        'absolute top-1 right-1 p-1.5 rounded-md',
        'bg-background/90 hover:bg-background',
        'border border-border',
        'shadow-sm',
        'transition-all',
        'z-10',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className
      )}
      title="Copy to clipboard (Ctrl/Cmd + Click)"
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
