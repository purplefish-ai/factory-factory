import { AlertTriangle, FileText, Loader2, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import type { RewindPreviewState } from './reducer';

export interface RewindConfirmationDialogProps {
  /** Preview state from the reducer (null when dialog should be closed) */
  rewindPreview: RewindPreviewState | null;
  /** Callback to confirm the rewind */
  onConfirm: () => void;
  /** Callback to cancel the rewind */
  onCancel: () => void;
}

/**
 * Confirmation dialog for the rewind files feature.
 *
 * Shows a preview of files that will be affected and allows the user
 * to confirm or cancel the rewind operation.
 */
export function RewindConfirmationDialog({
  rewindPreview,
  onConfirm,
  onCancel,
}: RewindConfirmationDialogProps) {
  const isOpen = rewindPreview !== null;
  const isLoading = rewindPreview?.isLoading ?? false;
  const isExecuting = rewindPreview?.isExecuting ?? false;
  const hasError = !!rewindPreview?.error;
  const affectedFiles = rewindPreview?.affectedFiles ?? [];
  const hasFiles = affectedFiles.length > 0;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RotateCcw className="h-5 w-5 text-amber-500" />
            Rewind Files
          </DialogTitle>
          <DialogDescription>
            This will revert file changes to the state before the selected message was processed.
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          {isLoading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              <span className="ml-2 text-sm text-muted-foreground">
                {isExecuting ? 'Reverting files...' : 'Loading preview...'}
              </span>
            </div>
          ) : hasError ? (
            <div className="flex items-start gap-3 rounded-lg border border-destructive/50 bg-destructive/10 p-3">
              <AlertTriangle className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" />
              <div className="text-sm text-destructive">{rewindPreview?.error}</div>
            </div>
          ) : hasFiles ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <FileText className="h-4 w-4 text-muted-foreground" />
                <span>Files that will be reverted:</span>
              </div>
              <div className="max-h-48 overflow-y-auto rounded-lg border bg-muted/30">
                <ul className="divide-y divide-border">
                  {affectedFiles.map((file) => (
                    <li key={file} className="px-3 py-2 text-sm font-mono truncate" title={file}>
                      {file}
                    </li>
                  ))}
                </ul>
              </div>
              <div
                className={cn(
                  'flex items-start gap-2 rounded-lg border p-3 text-sm',
                  'border-amber-500/50 bg-amber-50 dark:bg-amber-900/20'
                )}
              >
                <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                <span className="text-amber-800 dark:text-amber-200">
                  This action cannot be undone. Make sure you want to revert these changes.
                </span>
              </div>
            </div>
          ) : (
            <div className="text-center py-6 text-sm text-muted-foreground">
              No files were modified since this message. There's nothing to rewind.
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={isLoading}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={onConfirm}
            disabled={isLoading || hasError || !hasFiles}
            className="bg-amber-600 hover:bg-amber-700"
          >
            <RotateCcw className="mr-2 h-4 w-4" />
            Rewind Files
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
