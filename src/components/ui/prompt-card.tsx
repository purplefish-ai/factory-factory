import * as React from 'react';

import { cn } from '@/lib/utils';

// =============================================================================
// PromptCard - Shared card component for inline prompts (permissions, questions)
// =============================================================================

export interface PromptCardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** ARIA role for the card. Defaults to 'alertdialog' */
  role?: 'alertdialog' | 'form';
}

const PromptCard = React.forwardRef<HTMLDivElement, PromptCardProps>(
  ({ className, role = 'alertdialog', ...props }, ref) => (
    <div ref={ref} role={role} className={cn('border-b bg-muted/50 p-3', className)} {...props} />
  )
);
PromptCard.displayName = 'PromptCard';

// =============================================================================
// PromptCardContent - Main content area with flex layout
// =============================================================================

const PromptCardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex items-start gap-3', className)} {...props} />
  )
);
PromptCardContent.displayName = 'PromptCardContent';

// =============================================================================
// PromptCardIcon - Icon container with consistent sizing
// =============================================================================

const PromptCardIcon = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('shrink-0 mt-0.5', className)} aria-hidden="true" {...props} />
  )
);
PromptCardIcon.displayName = 'PromptCardIcon';

// =============================================================================
// PromptCardBody - Main text/form content area
// =============================================================================

const PromptCardBody = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex-1 min-w-0', className)} {...props} />
  )
);
PromptCardBody.displayName = 'PromptCardBody';

// =============================================================================
// PromptCardActions - Action buttons container
// =============================================================================

const PromptCardActions = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex gap-2 shrink-0', className)} {...props} />
  )
);
PromptCardActions.displayName = 'PromptCardActions';

export { PromptCard, PromptCardContent, PromptCardIcon, PromptCardBody, PromptCardActions };
