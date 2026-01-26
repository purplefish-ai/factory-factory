'use client';

import { ShieldAlert, ShieldCheck, ShieldX } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { PermissionRequest } from '@/lib/claude-types';

// =============================================================================
// Types
// =============================================================================

interface PermissionModalProps {
  permission: PermissionRequest | null;
  onApprove: (requestId: string, allow: boolean) => void;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Formats tool input for display in a readable way.
 */
function formatToolInput(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

/**
 * Gets a summary of the tool input for the description.
 */
function getInputSummary(input: Record<string, unknown>): string {
  const keys = Object.keys(input);
  if (keys.length === 0) {
    return 'No parameters';
  }
  if (keys.length === 1) {
    const value = input[keys[0]];
    if (typeof value === 'string' && value.length < 50) {
      return `${keys[0]}: ${value}`;
    }
    return `1 parameter: ${keys[0]}`;
  }
  return `${keys.length} parameters: ${keys.slice(0, 3).join(', ')}${keys.length > 3 ? '...' : ''}`;
}

// =============================================================================
// Main Component
// =============================================================================

/**
 * Modal dialog for approving or denying tool permission requests (Phase 9).
 */
export function PermissionModal({ permission, onApprove }: PermissionModalProps) {
  if (!permission) {
    return null;
  }

  const { requestId, toolName, toolInput } = permission;

  const handleAllow = () => {
    onApprove(requestId, true);
  };

  const handleDeny = () => {
    onApprove(requestId, false);
  };

  return (
    <Dialog
      open={!!permission}
      onOpenChange={() => {
        /* Modal cannot be dismissed */
      }}
    >
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-amber-500" />
            <DialogTitle>Permission Request</DialogTitle>
          </div>
          <DialogDescription>
            Claude wants to use the <strong>{toolName}</strong> tool.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <h4 className="text-sm font-medium mb-2">Tool Input</h4>
            <div className="bg-muted rounded-md p-3">
              <pre className="text-xs overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap">
                {formatToolInput(toolInput)}
              </pre>
            </div>
          </div>

          <div className="text-sm text-muted-foreground">
            <p>Summary: {getInputSummary(toolInput)}</p>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={handleDeny} className="gap-2">
            <ShieldX className="h-4 w-4" />
            Deny
          </Button>
          <Button onClick={handleAllow} className="gap-2">
            <ShieldCheck className="h-4 w-4" />
            Allow
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
