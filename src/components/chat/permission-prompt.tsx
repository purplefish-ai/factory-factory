'use client';

import { ShieldCheck, ShieldX, Terminal } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { PermissionRequest } from '@/lib/claude-types';

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
// Main Component
// =============================================================================

/**
 * Inline prompt for approving or denying tool permission requests.
 * Appears above the chat input as a compact card.
 */
export function PermissionPrompt({ permission, onApprove }: PermissionPromptProps) {
  if (!permission) {
    return null;
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
    <div className="border-t bg-muted/50 p-3">
      <div className="flex items-start gap-3">
        <Terminal className="h-5 w-5 shrink-0 text-muted-foreground mt-0.5" />
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
            <ShieldX className="h-3.5 w-3.5" />
            Deny
          </Button>
          <Button size="sm" onClick={handleAllow} className="gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5" />
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
    <div className="border-t bg-muted/50 p-3">
      <div className="flex items-start gap-3">
        <Terminal className="h-5 w-5 shrink-0 text-muted-foreground mt-0.5" />
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
            <ShieldX className="h-3.5 w-3.5" />
            Deny
          </Button>
          <Button size="sm" onClick={handleAllow} className="gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5" />
            Allow
          </Button>
        </div>
      </div>
    </div>
  );
}
