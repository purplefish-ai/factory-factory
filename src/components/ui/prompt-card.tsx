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
  /** Additional class names */
  className?: string;
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
  className,
}: PromptCardProps) {
  return (
    <div className={cn('border-b bg-muted/50 p-3', className)} role={role}>
      <div className="flex items-start gap-3">
        <div className="shrink-0 mt-0.5">{icon}</div>
        <div className="flex-1 min-w-0">{children}</div>
        {actions && <div className="flex gap-2 shrink-0">{actions}</div>}
      </div>
    </div>
  );
}
