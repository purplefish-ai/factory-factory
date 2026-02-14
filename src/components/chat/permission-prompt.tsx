import { FileText, ShieldCheck, ShieldX, Terminal } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { MarkdownRenderer } from '@/components/ui/markdown';
import { PromptCard } from '@/components/ui/prompt-card';
import type { PermissionRequest } from '@/lib/chat-protocol';
import { cn } from '@/lib/utils';
import { type PlanViewMode, usePlanViewMode } from './plan-view-preference';

// =============================================================================
// Types
// =============================================================================

interface PermissionPromptProps {
  permission: PermissionRequest | null;
  onApprove: (requestId: string, allow: boolean, optionId?: string) => void;
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

  const firstKey = keys[0];
  if (!firstKey) {
    return 'No parameters';
  }
  const firstValue = input[firstKey];
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

function parsePlanFromJsonString(value: string): string | null {
  const trimmed = value.trim();
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === 'object' && parsed !== null) {
      const maybePlan = Reflect.get(parsed, 'plan');
      if (typeof maybePlan === 'string') {
        return maybePlan;
      }
    }
  } catch {
    return null;
  }

  return null;
}

function resolvePlanContent(permission: PermissionRequest): string | null {
  const fromField = permission.planContent;
  if (typeof fromField === 'string' && fromField.length > 0) {
    return parsePlanFromJsonString(fromField) ?? fromField;
  }

  const fromInput = permission.toolInput.plan;
  if (typeof fromInput === 'string' && fromInput.length > 0) {
    return parsePlanFromJsonString(fromInput) ?? fromInput;
  }
  if (typeof fromInput === 'object' && fromInput !== null) {
    const nestedPlan = Reflect.get(fromInput, 'plan');
    if (typeof nestedPlan === 'string') {
      return nestedPlan;
    }
    try {
      return JSON.stringify(fromInput, null, 2);
    } catch {
      return String(fromInput);
    }
  }

  return null;
}

// =============================================================================
// Plan View Toggle
// =============================================================================

interface PlanViewToggleProps {
  value: PlanViewMode;
  onChange: (mode: PlanViewMode) => void;
}

function PlanViewToggle({ value, onChange }: PlanViewToggleProps) {
  return (
    <div className="flex items-center rounded-md border bg-background p-0.5">
      {(['rendered', 'raw'] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          aria-pressed={value === mode}
          onClick={() => onChange(mode)}
          className={cn(
            'text-[11px] px-2 py-1 rounded-sm transition-colors',
            value === mode
              ? 'bg-muted text-foreground'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {mode === 'rendered' ? 'Rendered' : 'Raw'}
        </button>
      ))}
    </div>
  );
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
  const [viewMode, setViewMode] = usePlanViewMode();
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

  const { requestId } = permission;
  const planContent = resolvePlanContent(permission);

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
          <div className="flex items-center gap-2">
            {planContent && <PlanViewToggle value={viewMode} onChange={setViewMode} />}
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {expanded ? 'Collapse' : 'Expand'}
            </button>
          </div>
        </div>

        {/* Plan Content */}
        {expanded && planContent && (
          <div className="bg-background rounded-md border overflow-hidden">
            <div className="max-h-[70vh] overflow-auto">
              {viewMode === 'rendered' ? (
                <div className="p-3">
                  <MarkdownRenderer content={planContent} />
                </div>
              ) : (
                <pre className="text-xs p-3 whitespace-pre-wrap font-mono">{planContent}</pre>
              )}
            </div>
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
// ACP Multi-Option Permission Component
// =============================================================================

/**
 * Multi-option permission prompt for ACP sessions.
 * Renders distinct buttons for each permission option (allow once, allow always,
 * reject once, reject always) instead of the binary Allow/Deny UI.
 */
function AcpPermissionPrompt({ permission, onApprove }: PermissionPromptProps) {
  const firstButtonRef = useRef<HTMLButtonElement>(null);
  const permissionRequestId = permission?.requestId;

  useEffect(() => {
    if (!permissionRequestId) {
      return;
    }
    const timeoutId = setTimeout(() => firstButtonRef.current?.focus(), 100);
    return () => clearTimeout(timeoutId);
  }, [permissionRequestId]);

  if (!permission?.acpOptions) {
    return null;
  }

  const { requestId, toolName, toolInput, acpOptions } = permission;
  const inputPreview = getInputPreview(toolInput);

  // Group options: allow options first, then reject options
  const allowOptions = acpOptions.filter((o) => o.kind.startsWith('allow'));
  const rejectOptions = acpOptions.filter((o) => o.kind.startsWith('reject'));

  const handleOptionClick = (optionId: string, kind: string) => {
    const isAllow = kind.startsWith('allow');
    onApprove(requestId, isAllow, optionId);
  };

  // Icon and color based on option kind
  const getOptionStyle = (kind: string) => {
    switch (kind) {
      case 'allow_once':
        return { variant: 'outline' as const, icon: ShieldCheck };
      case 'allow_always':
        return { variant: 'default' as const, icon: ShieldCheck };
      case 'reject_once':
        return { variant: 'outline' as const, icon: ShieldX };
      case 'reject_always':
        return { variant: 'destructive' as const, icon: ShieldX };
      default:
        return { variant: 'outline' as const, icon: ShieldCheck };
    }
  };

  return (
    <PromptCard
      icon={<Terminal className="h-5 w-5 text-muted-foreground" aria-hidden="true" />}
      label={`Permission request for ${toolName}`}
      actions={
        <div className="flex flex-wrap gap-2">
          {[...allowOptions, ...rejectOptions].map((option, index) => {
            const style = getOptionStyle(option.kind);
            const Icon = style.icon;
            return (
              <Button
                key={option.optionId}
                ref={index === 0 ? firstButtonRef : undefined}
                variant={style.variant}
                size="sm"
                onClick={() => handleOptionClick(option.optionId, option.kind)}
                className="gap-1.5"
              >
                <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                {option.name}
              </Button>
            );
          })}
        </div>
      }
    >
      <div className="text-sm font-medium">Permission: {toolName}</div>
      <div className="text-xs text-muted-foreground mt-1 font-mono truncate" title={inputPreview}>
        {inputPreview}
      </div>
    </PromptCard>
  );
}

// =============================================================================
// Main Component
// =============================================================================

/**
 * Inline prompt for approving or denying tool permission requests.
 * Appears above the chat input as a compact card.
 * For ExitPlanMode requests, shows a specialized plan approval view.
 * For ACP requests with acpOptions, shows multi-option permission buttons.
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

  // ACP multi-option permissions
  if (permission.acpOptions && permission.acpOptions.length > 0) {
    return <AcpPermissionPrompt permission={permission} onApprove={onApprove} />;
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
    <PromptCard
      icon={<Terminal className="h-5 w-5 text-muted-foreground" aria-hidden="true" />}
      label={`Permission request for ${toolName}`}
      actions={
        <>
          <Button variant="outline" size="sm" onClick={handleDeny} className="gap-1.5">
            <ShieldX className="h-3.5 w-3.5" aria-hidden="true" />
            Deny
          </Button>
          <Button ref={allowButtonRef} size="sm" onClick={handleAllow} className="gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
            Allow
          </Button>
        </>
      }
    >
      <div className="text-sm font-medium">Permission: {toolName}</div>
      <div className="text-xs text-muted-foreground mt-1 font-mono truncate" title={inputPreview}>
        {inputPreview}
      </div>
    </PromptCard>
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
    <PromptCard
      icon={<Terminal className="h-5 w-5 text-muted-foreground" aria-hidden="true" />}
      label={`Permission request for ${toolName}`}
      actions={
        <>
          <Button variant="outline" size="sm" onClick={handleDeny} className="gap-1.5">
            <ShieldX className="h-3.5 w-3.5" aria-hidden="true" />
            Deny
          </Button>
          <Button ref={allowButtonRef} size="sm" onClick={handleAllow} className="gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
            Allow
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        <div className="text-sm font-medium">Permission: {toolName}</div>
        <div className="bg-background rounded-md p-2 border">
          <pre className="text-xs overflow-x-auto max-h-32 overflow-y-auto whitespace-pre-wrap font-mono">
            {formatToolInput(toolInput)}
          </pre>
        </div>
      </div>
    </PromptCard>
  );
}
