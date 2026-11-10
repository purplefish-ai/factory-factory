import type { ReactNode } from 'react';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  /** Extra body content below the description, such as a warning. */
  children?: ReactNode;
  confirmText?: string;
  /** Confirm label while `isPending` ("Deleting…"); defaults to `confirmText`. */
  pendingText?: string;
  cancelText?: string;
  variant?: 'default' | 'destructive';
  /**
   * Runs the action. The dialog stays open; close it from the action's success
   * handler, or call `onOpenChange(false)` here for an optimistic action.
   */
  onConfirm: () => void;
  /** An outline button between Cancel and Confirm, such as "Retry". */
  secondaryAction?: { label: string; onClick: () => void };
  /**
   * The confirmed action is in flight. The confirm button shows a spinner
   * beside its label, every button is disabled, and the dialog ignores close
   * requests (Escape, Cancel) until the action settles.
   */
  isPending?: boolean;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmText = 'Continue',
  pendingText,
  cancelText = 'Cancel',
  variant = 'default',
  onConfirm,
  secondaryAction,
  isPending = false,
}: ConfirmDialogProps) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (next || !isPending) {
          onOpenChange(next);
        }
      }}
    >
      <AlertDialogContent
        // The dialog is portaled, but React still bubbles its clicks to the
        // component that rendered it, such as a clickable card.
        onClick={(event) => event.stopPropagation()}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {children}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>{cancelText}</AlertDialogCancel>
          {secondaryAction && (
            <Button variant="outline" disabled={isPending} onClick={secondaryAction.onClick}>
              {secondaryAction.label}
            </Button>
          )}
          <Button
            variant={variant}
            pending={isPending}
            pendingLabel={pendingText}
            onClick={onConfirm}
          >
            {confirmText}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
