import { cn } from '@/lib/utils';

// =============================================================================
// Types
// =============================================================================

interface PromptCardProps {
  /** Icon element to display in the left column */
  icon: React.ReactNode;
  /** Main content of the prompt */
  children: React.ReactNode;
  /** Action buttons to display on the right */
  actions?: React.ReactNode;
  /** ARIA role for the card (default: 'alertdialog') */
  role?: 'alertdialog' | 'form' | 'dialog';
  /** Accessible name for the card when needed */
  label?: string;
  /** Additional class names */
  className?: string;
  /** Hide the icon on mobile breakpoints while keeping it on sm+ */
  hideIconOnMobile?: boolean;
}

// =============================================================================
// Component
// =============================================================================

/**
 * Shared prompt card component for inline prompts.
 * Used for permission prompts, question prompts, and similar UI patterns.
 * Displays above the chat input as a compact card.
 */
export function PromptCard({
  icon,
  children,
  actions,
  role = 'alertdialog',
  label,
  className,
  hideIconOnMobile = false,
}: PromptCardProps) {
  return (
    <div className={cn('border-b bg-muted/50 p-3', className)} role={role}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        {label && <span className="sr-only">{label}</span>}
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <div className={cn('mt-0.5 shrink-0', hideIconOnMobile && 'hidden sm:block')}>{icon}</div>
          <div className="min-w-0 flex-1">{children}</div>
        </div>
        {actions && (
          <div className="flex w-full flex-wrap justify-end gap-2 sm:w-auto sm:shrink-0 sm:flex-nowrap">
            {actions}
          </div>
        )}
      </div>
    </div>
  );
}
