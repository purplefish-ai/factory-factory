import { X } from 'lucide-react';
import * as React from 'react';

import { cn } from '@/lib/utils';

// =============================================================================
// PanelTab - Shared tab button component for panel navigation
// =============================================================================

export interface PanelTabProps extends React.HTMLAttributes<HTMLDivElement> {
  /** The tab label text */
  label: string;
  /** Icon element to display before the label */
  icon?: React.ReactNode;
  /** Whether this tab is currently active/selected */
  isActive: boolean;
  /** Callback when the tab is clicked/selected */
  onSelect: () => void;
  /** Optional callback when close button is clicked. If provided, shows a close button */
  onClose?: () => void;
  /** Whether to truncate long labels. Defaults to false */
  truncate?: boolean;
}

const PanelTab = React.forwardRef<HTMLDivElement, PanelTabProps>(
  ({ className, label, icon, isActive, onSelect, onClose, truncate = false, ...props }, ref) => {
    const handleClose = React.useCallback(
      (e: React.MouseEvent) => {
        e.stopPropagation();
        onClose?.();
      },
      [onClose]
    );

    const handleKeyDown = React.useCallback(
      (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      },
      [onSelect]
    );

    return (
      <div
        ref={ref}
        role="tab"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={handleKeyDown}
        aria-selected={isActive}
        className={cn(
          'group relative flex items-center gap-1.5 px-2 py-1 text-sm font-medium cursor-pointer',
          'rounded-md transition-all whitespace-nowrap',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          'border',
          isActive
            ? 'bg-background text-foreground shadow-sm border-border'
            : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground border-transparent',
          className
        )}
        {...props}
      >
        {icon}
        <span className={cn(truncate && 'truncate max-w-[120px]')}>{label}</span>

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
);
PanelTab.displayName = 'PanelTab';

export { PanelTab };
