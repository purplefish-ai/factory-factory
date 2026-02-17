import { X } from 'lucide-react';
import { useCallback } from 'react';

import { cn } from '@/lib/utils';

// =============================================================================
// Types
// =============================================================================

interface TabButtonProps {
  /** Icon element to display (e.g., Lucide icon) */
  icon: React.ReactNode;
  /** Tab label text */
  label: string;
  /** Whether this tab is currently active */
  isActive: boolean;
  /** Handler called when the tab is selected */
  onSelect: () => void;
  /** Optional handler for close button - if provided, shows close button */
  onClose?: () => void;
  /** Whether to truncate long labels (default: false) */
  truncate?: boolean;
  /** Maximum width for label when truncating (default: 120px) */
  maxLabelWidth?: number;
  /** Additional class names */
  className?: string;
  /** Position of the icon relative to label (default: left) */
  iconSide?: 'left' | 'right';
}

// =============================================================================
// Component
// =============================================================================

/**
 * Shared tab button component for tab bars.
 * Used in panel tab bars and main view tab bars.
 */
export function TabButton({
  icon,
  label,
  isActive,
  onSelect,
  onClose,
  truncate = false,
  maxLabelWidth = 120,
  className,
  iconSide = 'left',
}: TabButtonProps) {
  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onClose?.();
    },
    [onClose]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onSelect();
      }
    },
    [onSelect]
  );
  const iconOnRight = iconSide === 'right';

  // Simple button variant (no close button, no keyboard handling)
  if (!(onClose || truncate)) {
    return (
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          'flex h-7 items-center gap-1 rounded-none border px-2 text-sm font-medium transition-colors',
          isActive
            ? 'bg-background text-foreground shadow-sm border-border'
            : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground border-transparent',
          className
        )}
      >
        {!iconOnRight && icon}
        {label}
        {iconOnRight && icon}
      </button>
    );
  }

  // Full variant with keyboard handling, optional close button, and truncation
  return (
    <div
      role="tab"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={handleKeyDown}
      aria-selected={isActive}
      className={cn(
        'group relative flex h-7 cursor-pointer items-center gap-1.5 rounded-none px-2 text-sm font-medium',
        'transition-all whitespace-nowrap',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        'border',
        isActive
          ? 'bg-background text-foreground shadow-sm border-border'
          : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground border-transparent',
        className
      )}
    >
      {!iconOnRight && icon}
      <span
        className={cn(truncate && 'truncate')}
        style={truncate ? { maxWidth: maxLabelWidth } : undefined}
      >
        {label}
      </span>
      {iconOnRight && icon}

      {onClose && (
        <button
          type="button"
          onClick={handleClose}
          className={cn(
            'ml-1 rounded p-0.5 opacity-0 transition-opacity',
            'hover:bg-muted-foreground/20 focus-visible:opacity-100',
            'group-hover:opacity-100'
          )}
          aria-label={`Close ${label}`}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}
