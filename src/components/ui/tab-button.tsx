import { XIcon } from '@phosphor-icons/react/dist/csr/X';
import { useCallback } from 'react';
import { getAriaKeyShortcuts, matchesShortcut } from '@/client/lib/keyboard-shortcuts';
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
  /**
   * Whether this tab is the tablist's Tab stop (roving tabindex). Defaults to
   * `isActive`; the tablist moves focus between tabs with the arrow keys.
   */
  tabStop?: boolean;
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
  tabStop = isActive,
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
      } else if (onClose && matchesShortcut(e, 'tabs.close')) {
        e.preventDefault();
        onClose();
      }
    },
    [onSelect, onClose]
  );
  const iconOnRight = iconSide === 'right';

  // Simple button variant (no close button, no keyboard handling)
  if (!(onClose || truncate)) {
    return (
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          'flex items-center gap-1 px-2 py-1 text-sm font-medium rounded-md transition-colors border',
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

  // Full variant: a tab for a `role="tablist"` with arrow-key focus, an optional
  // close button and truncation. The close button is the tab's sibling rather
  // than its child (interactive controls must not nest); it stays out of the
  // Tab order because Delete closes the focused tab.
  return (
    <div
      className={cn(
        'group relative flex items-center rounded-md transition-all whitespace-nowrap',
        'text-sm font-medium border',
        'has-[[role=tab]:focus-visible]:ring-2 has-[[role=tab]:focus-visible]:ring-ring has-[[role=tab]:focus-visible]:ring-offset-2',
        isActive
          ? 'bg-background text-foreground shadow-sm border-border'
          : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground border-transparent',
        className
      )}
    >
      <div
        role="tab"
        tabIndex={tabStop ? 0 : -1}
        onClick={onSelect}
        onKeyDown={handleKeyDown}
        aria-selected={isActive}
        aria-keyshortcuts={onClose ? getAriaKeyShortcuts('tabs.close') : undefined}
        className={cn(
          'flex min-w-0 cursor-pointer items-center gap-1.5 py-1 pl-2 outline-none',
          onClose ? 'pr-2.5' : 'pr-2'
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
      </div>

      {onClose && (
        <button
          type="button"
          tabIndex={-1}
          onClick={handleClose}
          className={cn(
            'mr-2 rounded p-0.5 transition-opacity',
            'hover-reveal',
            'hover:bg-muted-foreground/20'
          )}
          aria-label={`Close ${label}`}
        >
          <XIcon className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}
