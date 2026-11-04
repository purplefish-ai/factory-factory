import { WarningIcon } from '@phosphor-icons/react/dist/csr/Warning';
import { getPendingRequestPresentation } from '@/client/lib/pending-request-presentation';
import { StatusDot, StatusIcon } from './status-indicators';

interface WorkspaceStatusIconProps {
  pendingRequestType?: 'permission_request' | 'plan_approval' | 'user_question' | null;
  isWorking?: boolean;
  sessionRuntimeErrorMessage?: string | null;
}

/** Every pending request is "needs you"; the icon says which kind, as on chat tabs. */
const PENDING_REQUEST_ICON_NAMES = {
  permission_request: 'permission-request',
  plan_approval: 'plan-approval',
  user_question: 'user-question',
} as const;

export function WorkspaceStatusIcon({
  pendingRequestType,
  isWorking,
  sessionRuntimeErrorMessage,
}: WorkspaceStatusIconProps) {
  if (pendingRequestType) {
    return (
      <span
        data-icon={PENDING_REQUEST_ICON_NAMES[pendingRequestType]}
        className="inline-flex shrink-0"
      >
        <StatusIcon
          tone="attention"
          icon={getPendingRequestPresentation(pendingRequestType).icon}
        />
      </span>
    );
  }

  if (sessionRuntimeErrorMessage) {
    return (
      <span data-icon="runtime-error" className="inline-flex shrink-0">
        <StatusIcon tone="danger" icon={WarningIcon} />
      </span>
    );
  }

  return <StatusDot tone={isWorking ? 'working' : 'neutral'} />;
}
