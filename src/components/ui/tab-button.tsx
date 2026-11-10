import { XIcon } from '@phosphor-icons/react/dist/csr/X';
import type { ComponentProps, KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { getAriaKeyShortcuts, matchesShortcut } from '@/client/lib/keyboard-shortcuts';
import { handleTablistKeyDown } from '@/client/lib/roving-tablist';
import { cn } from '@/lib/utils';

// =============================================================================
// TabList
// =============================================================================

type TabListProps = Omit<ComponentProps<'div'>, 'role' | 'onKeyDown'> & {
  /** Names the group of tabs for assistive technology. */
  'aria-label': string;
};

/**
 * The `role="tablist"` for `TabButton`s: ←/→ move focus between tabs and
 * Home/End jump to the ends (`lib/roving-tablist.ts`); Enter or Space selects.
 * A tablist may contain only tabs and non-interactive elements, so keep other
 * buttons and menus outside it. Pair it with `useTablistFocus` on an ancestor
 * when tabs can be closed, so focus moves to a neighbour.
 */
export function TabList({ className, ...props }: TabListProps) {
  return (
    <div
      role="tablist"
      onKeyDown={handleTablistKeyDown}
      className={cn('flex items-center', className)}
      {...props}
    />
  );
}

// =============================================================================
// TabButton
// =============================================================================

const SIZE_CLASSES = {
  default: { wrapper: 'text-sm', tab: 'gap-1.5 py-1 pl-2', close: 'mr-2' },
  sm: { wrapper: 'text-xs', tab: 'gap-1 py-0.5 pl-2', close: 'mr-1' },
} as const;

interface TabButtonProps {
  /** Leading content: an icon or a status indicator. */
  icon?: ReactNode;
  /** Tab label text; it always names the tab, even when hidden. */
  label: string;
  /** Show only the icon; the label stays available to assistive technology. */
  hideLabel?: boolean;
  /** Whether this tab is currently selected. */
  isActive: boolean;
  /** Handler called when the tab is selected. */
  onSelect: () => void;
  /** Shows a close button and lets Delete close the focused tab. */
  onClose?: () => void;
  /** Truncate long labels at 120px. */
  truncate?: boolean;
  /** `sm` is the compact text-xs tab (terminal tabs, log sources). */
  size?: keyof typeof SIZE_CLASSES;
  /** Dims the tab and ignores selection and close. */
  disabled?: boolean;
  /** Native tooltip for the tab. */
  title?: string;
  /** Additional class names for the tab's outer wrapper. */
  className?: string;
  /**
   * Whether this tab is the tablist's Tab stop (roving tabindex). Defaults to
   * `isActive`; the tablist moves focus between tabs with the arrow keys.
   */
  tabStop?: boolean;
}

/**
 * The one tab for every tab bar: render it inside a `TabList`. The close
 * button is the tab's sibling rather than its child (interactive controls must
 * not nest); it stays out of the Tab order because Delete closes the focused
 * tab.
 */
export function TabButton({
  icon,
  label,
  hideLabel = false,
  isActive,
  onSelect,
  onClose,
  truncate = false,
  size = 'default',
  disabled = false,
  title,
  className,
  tabStop = isActive,
}: TabButtonProps) {
  const sizeClasses = SIZE_CLASSES[size];

  const handleClose = (e: MouseEvent) => {
    e.stopPropagation();
    onClose?.();
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (disabled) {
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect();
    } else if (onClose && matchesShortcut(e, 'tabs.close')) {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div
      className={cn(
        'group relative flex shrink-0 items-center rounded-md border font-medium whitespace-nowrap transition-all',
        sizeClasses.wrapper,
        'has-[[role=tab]:focus-visible]:ring-2 has-[[role=tab]:focus-visible]:ring-ring has-[[role=tab]:focus-visible]:ring-offset-2',
        isActive
          ? 'bg-background text-foreground shadow-sm border-border'
          : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground border-transparent',
        disabled && 'pointer-events-none opacity-50',
        className
      )}
    >
      <button
        type="button"
        role="tab"
        tabIndex={tabStop && !disabled ? 0 : -1}
        onClick={disabled ? undefined : onSelect}
        onKeyDown={handleKeyDown}
        title={title}
        aria-selected={isActive}
        aria-disabled={disabled || undefined}
        aria-keyshortcuts={onClose ? getAriaKeyShortcuts('tabs.close') : undefined}
        className={cn(
          'flex min-w-0 items-center outline-none',
          sizeClasses.tab,
          hideLabel ? 'px-1' : onClose ? 'pr-2.5' : 'pr-2',
          disabled ? 'cursor-default' : 'cursor-pointer'
        )}
      >
        {icon}
        <span className={cn(hideLabel ? 'sr-only' : truncate && 'max-w-[120px] truncate')}>
          {label}
        </span>
      </button>

      {onClose && (
        <button
          type="button"
          tabIndex={-1}
          onClick={handleClose}
          disabled={disabled}
          className={cn(
            'rounded p-0.5 transition-opacity hover-reveal hover:bg-muted-foreground/20',
            sizeClasses.close
          )}
          aria-label={`Close ${label}`}
        >
          <XIcon className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}
