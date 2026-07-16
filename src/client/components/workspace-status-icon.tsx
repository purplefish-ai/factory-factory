import {
  ChatCircleDotsIcon,
  ClipboardTextIcon,
  ShieldWarningIcon,
  WarningIcon,
} from '@phosphor-icons/react';

interface WorkspaceStatusIconProps {
  pendingRequestType?: 'permission_request' | 'plan_approval' | 'user_question' | null;
  isWorking?: boolean;
  sessionRuntimeErrorMessage?: string | null;
}

export function WorkspaceStatusIcon({
  pendingRequestType,
  isWorking,
  sessionRuntimeErrorMessage,
}: WorkspaceStatusIconProps) {
  if (pendingRequestType) {
    switch (pendingRequestType) {
      case 'permission_request':
        return (
          <ShieldWarningIcon
            data-icon="permission-request"
            className="h-3.5 w-3.5 shrink-0 text-orange-500"
          />
        );
      case 'plan_approval':
        return (
          <ClipboardTextIcon
            data-icon="plan-approval"
            className="h-3.5 w-3.5 shrink-0 text-amber-500"
          />
        );
      case 'user_question':
        return (
          <ChatCircleDotsIcon
            data-icon="user-question"
            className="h-3.5 w-3.5 shrink-0 text-blue-500"
          />
        );
    }
  }

  if (sessionRuntimeErrorMessage) {
    return (
      <WarningIcon data-icon="runtime-error" className="h-3.5 w-3.5 shrink-0 text-amber-500" />
    );
  }

  if (isWorking) {
    return <span className="h-2 w-2 shrink-0 rounded-full bg-brand animate-pulse" />;
  }

  return <span className="h-2 w-2 shrink-0 rounded-full bg-muted-foreground/30" />;
}
