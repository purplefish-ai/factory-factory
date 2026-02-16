import { FileText, ShieldCheck, ShieldX, Terminal } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { MarkdownRenderer } from '@/components/ui/markdown';
import { PromptCard } from '@/components/ui/prompt-card';
import type { PermissionRequest } from '@/lib/chat-protocol';
import { cn } from '@/lib/utils';
import { extractPlanText } from '@/shared/acp-protocol/plan-content';
import { type PlanViewMode, usePlanViewMode } from './plan-view-preference';

// =============================================================================
// Types
// =============================================================================

interface PermissionPromptProps {
  permission: PermissionRequest | null;
  onApprove: (requestId: string, allow: boolean, optionId?: string) => void;
}

interface PermissionOption {
  optionId: string;
  name: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
}

interface PermissionDecisionActionsProps {
  allowButtonRef: React.RefObject<HTMLButtonElement | null>;
  onAllow: () => void;
  onDeny: () => void;
}

interface PermissionDecisionCardProps extends PermissionDecisionActionsProps {
  toolName: string;
  children: React.ReactNode;
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

function useAutoFocusPermissionButton(
  buttonRef: React.RefObject<HTMLButtonElement | null>,
  permissionRequestId: string | undefined
) {
  useEffect(() => {
    if (!permissionRequestId) {
      return;
    }
    // Small delay to ensure the element is rendered and focusable.
    const timeoutId = setTimeout(() => {
      buttonRef.current?.focus();
    }, 100);
    return () => clearTimeout(timeoutId);
  }, [permissionRequestId, buttonRef]);
}

function PermissionDecisionActions({
  allowButtonRef,
  onAllow,
  onDeny,
}: PermissionDecisionActionsProps) {
  return (
    <>
      <Button variant="outline" size="sm" onClick={onDeny} className="gap-1.5">
        <ShieldX className="h-3.5 w-3.5" aria-hidden="true" />
        Deny
      </Button>
      <Button ref={allowButtonRef} size="sm" onClick={onAllow} className="gap-1.5">
        <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
        Allow
      </Button>
    </>
  );
}

function PermissionDecisionCard({
  toolName,
  allowButtonRef,
  onAllow,
  onDeny,
  children,
}: PermissionDecisionCardProps) {
  return (
    <PromptCard
      icon={<Terminal className="h-5 w-5 text-muted-foreground" aria-hidden="true" />}
      label={`Permission request for ${toolName}`}
      actions={
        <PermissionDecisionActions
          allowButtonRef={allowButtonRef}
          onAllow={onAllow}
          onDeny={onDeny}
        />
      }
    >
      {children}
    </PromptCard>
  );
}

function resolvePlanContent(permission: PermissionRequest): string | null {
  const fromField = extractPlanText(permission.planContent);
  if (fromField) {
    return fromField;
  }

  const fromInput = extractPlanText(permission.toolInput.plan);
  if (fromInput) {
    return fromInput;
  }

  if (typeof permission.planContent === 'string' && permission.planContent.length > 0) {
    return permission.planContent;
  }

  if (typeof permission.toolInput.plan === 'string' && permission.toolInput.plan.length > 0) {
    return permission.toolInput.plan;
  }

  if (typeof permission.toolInput.plan === 'object' && permission.toolInput.plan !== null) {
    try {
      return JSON.stringify(permission.toolInput.plan, null, 2);
    } catch {
      return String(permission.toolInput.plan);
    }
  }

  return null;
}

function getPermissionOptionStyle(kind: PermissionOption['kind']) {
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
  const firstActionButtonRef = useRef<HTMLButtonElement>(null);
  const [expanded, setExpanded] = useState(true);
  const [viewMode, setViewMode] = usePlanViewMode();
  const permissionRequestId = permission?.requestId;

  useEffect(() => {
    if (!permissionRequestId) {
      return;
    }
    const timeoutId = setTimeout(() => {
      firstActionButtonRef.current?.focus();
    }, 100);
    return () => clearTimeout(timeoutId);
  }, [permissionRequestId]);

  if (!permission) {
    return null;
  }

  const { requestId } = permission;
  const planContent = resolvePlanContent(permission);
  const options: PermissionOption[] =
    permission.acpOptions && permission.acpOptions.length > 0
      ? [...permission.acpOptions].sort((left, right) => {
          const leftAllow = left.kind.startsWith('allow');
          const rightAllow = right.kind.startsWith('allow');
          if (leftAllow === rightAllow) {
            return 0;
          }
          return leftAllow ? -1 : 1;
        })
      : [
          { optionId: 'default', name: 'Approve Plan', kind: 'allow_once' },
          { optionId: 'plan', name: 'Keep Planning', kind: 'reject_once' },
        ];

  const handleOptionClick = (option: PermissionOption) => {
    onApprove(requestId, option.kind.startsWith('allow'), option.optionId);
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
          Choose Keep planning to request revisions, then send follow-up guidance in chat.
        </p>

        {/* Actions */}
        <div className="flex justify-end gap-2">
          {options.map((option, index) => {
            const style = getPermissionOptionStyle(option.kind);
            const Icon = style.icon;
            return (
              <Button
                key={option.optionId}
                ref={index === 0 ? firstActionButtonRef : undefined}
                variant={style.variant}
                size="sm"
                onClick={() => handleOptionClick(option)}
                className="gap-1.5"
              >
                <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                {option.name}
              </Button>
            );
          })}
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

  return (
    <PromptCard
      icon={<Terminal className="h-5 w-5 text-muted-foreground" aria-hidden="true" />}
      label={`Permission request for ${toolName}`}
      actions={
        <div className="flex flex-wrap gap-2">
          {[...allowOptions, ...rejectOptions].map((option, index) => {
            const style = getPermissionOptionStyle(option.kind);
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
  useAutoFocusPermissionButton(allowButtonRef, permission?.requestId);

  if (!permission) {
    return null;
  }

  // ExitPlanMode always uses plan-specific view so plan content is visible.
  if (permission.toolName === 'ExitPlanMode') {
    return <PlanApprovalPrompt permission={permission} onApprove={onApprove} />;
  }

  // ACP multi-option permissions
  if (permission.acpOptions && permission.acpOptions.length > 0) {
    return <AcpPermissionPrompt permission={permission} onApprove={onApprove} />;
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
    <PermissionDecisionCard
      toolName={toolName}
      allowButtonRef={allowButtonRef}
      onAllow={handleAllow}
      onDeny={handleDeny}
    >
      <div className="text-sm font-medium">Permission: {toolName}</div>
      <div className="text-xs text-muted-foreground mt-1 font-mono truncate" title={inputPreview}>
        {inputPreview}
      </div>
    </PermissionDecisionCard>
  );
}

/**
 * Expanded inline prompt with full tool input details.
 * Use when more context is needed before approval.
 */
export function PermissionPromptExpanded({ permission, onApprove }: PermissionPromptProps) {
  const allowButtonRef = useRef<HTMLButtonElement>(null);
  useAutoFocusPermissionButton(allowButtonRef, permission?.requestId);

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
    <PermissionDecisionCard
      toolName={toolName}
      allowButtonRef={allowButtonRef}
      onAllow={handleAllow}
      onDeny={handleDeny}
    >
      <div className="space-y-2">
        <div className="text-sm font-medium">Permission: {toolName}</div>
        <div className="bg-background rounded-md p-2 border">
          <pre className="text-xs overflow-x-auto max-h-32 overflow-y-auto whitespace-pre-wrap font-mono">
            {formatToolInput(toolInput)}
          </pre>
        </div>
      </div>
    </PermissionDecisionCard>
  );
}
