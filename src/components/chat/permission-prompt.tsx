import { FileText, ShieldCheck, ShieldX, Terminal } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import type { PermissionRequest } from '@/lib/claude-types';
import { cn } from '@/lib/utils';

// =============================================================================
// Types
// =============================================================================

interface PermissionPromptProps {
  permission: PermissionRequest | null;
  onApprove: (requestId: string, allow: boolean) => void;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Gets a compact preview of the tool input.
 */
function getInputPreview(input: Record<string, unknown>): string {
  // For common tools, show the most relevant parameter
  if ('command' in input && typeof input.command === 'string') {
    return input.command;
  }
  if ('file_path' in input && typeof input.file_path === 'string') {
    return input.file_path;
  }
  if ('pattern' in input && typeof input.pattern === 'string') {
    return input.pattern;
  }

  // Fallback to first string parameter or key list
  const keys = Object.keys(input);
  if (keys.length === 0) {
    return 'No parameters';
  }

  const firstValue = input[keys[0]];
  if (typeof firstValue === 'string' && firstValue.length < 100) {
    return firstValue;
  }

  return `${keys.length} parameter${keys.length === 1 ? '' : 's'}`;
}

/**
 * Formats tool input for display in expanded view.
 */
function formatToolInput(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

// =============================================================================
// Plan Approval Component
// =============================================================================

/**
 * Specialized prompt for approving plans in ExitPlanMode.
 * Displays the plan content with expand/collapse functionality.
 */
function PlanApprovalPrompt({ permission, onApprove }: PermissionPromptProps) {
  const approveButtonRef = useRef<HTMLButtonElement>(null);
  const [expanded, setExpanded] = useState(true);
  const permissionRequestId = permission?.requestId;

  useEffect(() => {
    if (!permissionRequestId) {
      return;
    }
    const timeoutId = setTimeout(() => {
      approveButtonRef.current?.focus();
    }, 100);
    return () => clearTimeout(timeoutId);
  }, [permissionRequestId]);

  if (!permission) {
    return null;
  }

  const { requestId, planContent } = permission;

  const handleApprove = () => {
    onApprove(requestId, true);
  };

  const handleReject = () => {
    onApprove(requestId, false);
  };

  return (
    <div className="border-b bg-muted/50 p-3" role="alertdialog" aria-label="Plan approval request">
      <div className="space-y-3">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileText className="h-5 w-5 shrink-0 text-blue-500" aria-hidden="true" />
            <span className="text-sm font-medium">Review Plan</span>
          </div>
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {expanded ? 'Collapse' : 'Expand'}
          </button>
        </div>

        {/* Plan Content */}
        {expanded && planContent && (
          <div className="bg-background rounded-md border overflow-hidden">
            <pre
              className={cn(
                'text-xs p-3 overflow-auto whitespace-pre-wrap font-mono',
                'max-h-64' // Limit height with scroll
              )}
            >
              {planContent}
            </pre>
          </div>
        )}

        {!planContent && (
          <div className="text-xs text-muted-foreground italic">No plan content available</div>
        )}

        <p className="text-[11px] text-muted-foreground">
          You can also type feedback in the chat input below to request changes.
        </p>

        {/* Actions */}
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={handleReject} className="gap-1.5">
            <ShieldX className="h-3.5 w-3.5" aria-hidden="true" />
            Reject Plan
          </Button>
          <Button ref={approveButtonRef} size="sm" onClick={handleApprove} className="gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
            Approve Plan
          </Button>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// Main Component
// =============================================================================

/**
 * Inline prompt for approving or denying tool permission requests.
 * Appears above the chat input as a compact card.
 * For ExitPlanMode requests, shows a specialized plan approval view.
 */
export function PermissionPrompt({ permission, onApprove }: PermissionPromptProps) {
  const allowButtonRef = useRef<HTMLButtonElement>(null);
  const permissionRequestId = permission?.requestId;

  // Focus the Allow button when the prompt appears for keyboard accessibility
  useEffect(() => {
    if (!permissionRequestId) {
      return;
    }
    // Small delay to ensure the element is rendered and focusable
    const timeoutId = setTimeout(() => {
      allowButtonRef.current?.focus();
    }, 100);
    return () => clearTimeout(timeoutId);
  }, [permissionRequestId]);

  if (!permission) {
    return null;
  }

  // Use specialized view for ExitPlanMode
  if (permission.toolName === 'ExitPlanMode') {
    return <PlanApprovalPrompt permission={permission} onApprove={onApprove} />;
  }

  const { requestId, toolName, toolInput } = permission;
  const inputPreview = getInputPreview(toolInput);

  const handleAllow = () => {
    onApprove(requestId, true);
  };

  const handleDeny = () => {
    onApprove(requestId, false);
  };

  return (
    <div
      className="border-b bg-muted/50 p-3"
      role="alertdialog"
      aria-label={`Permission request for ${toolName}`}
    >
      <div className="flex items-start gap-3">
        <Terminal className="h-5 w-5 shrink-0 text-muted-foreground mt-0.5" aria-hidden="true" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium">Permission: {toolName}</div>
          <div
            className="text-xs text-muted-foreground mt-1 font-mono truncate"
            title={inputPreview}
          >
            {inputPreview}
          </div>
        </div>
        <div className="flex gap-2 shrink-0">
          <Button variant="outline" size="sm" onClick={handleDeny} className="gap-1.5">
            <ShieldX className="h-3.5 w-3.5" aria-hidden="true" />
            Deny
          </Button>
          <Button ref={allowButtonRef} size="sm" onClick={handleAllow} className="gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
            Allow
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Expanded inline prompt with full tool input details.
 * Use when more context is needed before approval.
 */
export function PermissionPromptExpanded({ permission, onApprove }: PermissionPromptProps) {
  const allowButtonRef = useRef<HTMLButtonElement>(null);
  const permissionRequestId = permission?.requestId;

  // Focus the Allow button when the prompt appears for keyboard accessibility
  useEffect(() => {
    if (!permissionRequestId) {
      return;
    }
    const timeoutId = setTimeout(() => {
      allowButtonRef.current?.focus();
    }, 100);
    return () => clearTimeout(timeoutId);
  }, [permissionRequestId]);

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
    <div
      className="border-b bg-muted/50 p-3"
      role="alertdialog"
      aria-label={`Permission request for ${toolName}`}
    >
      <div className="flex items-start gap-3">
        <Terminal className="h-5 w-5 shrink-0 text-muted-foreground mt-0.5" aria-hidden="true" />
        <div className="flex-1 min-w-0 space-y-2">
          <div className="text-sm font-medium">Permission: {toolName}</div>
          <div className="bg-background rounded-md p-2 border">
            <pre className="text-xs overflow-x-auto max-h-32 overflow-y-auto whitespace-pre-wrap font-mono">
              {formatToolInput(toolInput)}
            </pre>
          </div>
        </div>
        <div className="flex gap-2 shrink-0">
          <Button variant="outline" size="sm" onClick={handleDeny} className="gap-1.5">
            <ShieldX className="h-3.5 w-3.5" aria-hidden="true" />
            Deny
          </Button>
          <Button ref={allowButtonRef} size="sm" onClick={handleAllow} className="gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
            Allow
          </Button>
        </div>
      </div>
    </div>
  );
}
